"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as api from "@/lib/api";
import EntityProfileShell from "@/components/EntityProfileShell";

type GenericEntityProfileProps = {
  entityType: string;
  title: string;
  query: string;
  subtitle?: string;
  backHref?: string;
  emptyHint?: string;
};

export default function GenericEntityProfile({
  entityType,
  title,
  query,
  subtitle,
  backHref,
  emptyHint = "This profile will improve as more messages are captured.",
}: GenericEntityProfileProps) {
  const [results, setResults] = useState<api.RawSearchResult[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let mounted = true;
    setLoading(true);
    api.searchRawMessages(query, 20, 0)
      .then((data) => {
        if (!mounted) return;
        setResults(data.results || []);
        setCount(data.count || 0);
      })
      .catch(() => {
        if (!mounted) return;
        setResults([]);
        setCount(0);
      })
      .finally(() => {
        if (mounted) setLoading(false);
      });

    return () => {
      mounted = false;
    };
  }, [query]);

  return (
    <EntityProfileShell
      title={title}
      subtitle={subtitle || `${entityType} profile generated from captured messages.`}
      backHref={backHref || "/search"}
      backLabel="Back"
      metrics={[
        { label: "Mentions", value: count.toLocaleString(), tone: "accent" },
        { label: "Profile status", value: "Live", sub: "Generated on demand" },
        { label: "Entity type", value: entityType, sub: "First-class navigation target" },
        { label: "Coverage", value: loading ? "Loading" : count > 0 ? "Found" : "Empty", sub: "WhatsApp memory" },
      ]}
    >
      <div className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-white">Recent mentions</h2>
            <div className="text-xs text-zinc-500">Messages that reference this entity.</div>
          </div>
          <Link
            href={`/search?q=${encodeURIComponent(query)}`}
            className="text-xs font-semibold text-[#3EE88A] hover:underline"
          >
            Open search
          </Link>
        </div>

        {loading ? (
          <div className="py-10 text-center text-xs text-zinc-500">Loading profile...</div>
        ) : results.length === 0 ? (
          <div className="py-10 text-center text-xs text-zinc-500">{emptyHint}</div>
        ) : (
          <div className="mt-4 space-y-2">
            {results.map((result) => (
              <div
                key={result.id}
                className="rounded-xl border border-white/10 bg-[#0a0f14] p-4 transition-colors hover:border-[rgba(62,232,138,0.22)]"
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                    <span className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-400">
                      {result.group_name || "Direct Message"}
                    </span>
                    <span>{result.sender}</span>
                  </div>
                  <span className="text-[10px] text-zinc-500">
                    {new Date(result.timestamp).toLocaleString("en-IN", {
                      day: "2-digit",
                      month: "short",
                      hour: "2-digit",
                      minute: "2-digit",
                    })}
                  </span>
                </div>
                <div
                  className="mt-2 text-sm leading-relaxed text-white"
                  dangerouslySetInnerHTML={{ __html: result.snippet }}
                />
              </div>
            ))}
          </div>
        )}
      </div>
    </EntityProfileShell>
  );
}
