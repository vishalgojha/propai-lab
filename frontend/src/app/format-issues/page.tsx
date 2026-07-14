"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { AlertTriangle, ExternalLink, RefreshCw } from "lucide-react";
import * as api from "@/lib/api";
import { classifyFormatIssue, formatIssueHref, type FormatIssue } from "@/lib/format-issues";
import { displayGroupName, resolveSenderName } from "@/lib/whatsapp-display";

type IssueRow = {
  message: api.RawMessage;
  issue: FormatIssue;
};

function displaySource(message: api.RawMessage) {
  return message.chat_name || message.conversation_name || displayGroupName(message.group_name) || resolveSenderName(message) || "WhatsApp";
}

function displayTime(value?: string) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleString([], {
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function reasonTone(reason: string) {
  if (reason === "Too compressed" || reason === "Mixed listing + requirement") {
    return "border-amber-500/25 bg-amber-500/10 text-amber-300";
  }
  if (reason === "Only external link") return "border-red-500/25 bg-red-500/10 text-red-300";
  return "border-zinc-600/40 bg-zinc-800/70 text-zinc-300";
}

export default function FormatIssuesPage() {
  const [rows, setRows] = useState<IssueRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load() {
    setLoading(true);
    setError("");
    try {
      let messages: api.RawMessage[] = [];
      try {
        messages = await api.getRaw(500, 0);
      } catch {
        messages = await api.getInboxThreads(500, 0);
      }
      const next = messages
        .map((message) => {
          const issue = classifyFormatIssue(message);
          return issue ? { message, issue } : null;
        })
        .filter(Boolean) as IssueRow[];
      setRows(next);
    } catch {
      setError("Could not load format issues.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
  }, []);

  const counts = useMemo(() => {
    return rows.reduce<Record<string, number>>((acc, row) => {
      acc[row.issue.reason] = (acc[row.issue.reason] || 0) + 1;
      return acc;
    }, {});
  }, [rows]);

  return (
    <div className="min-h-screen bg-black text-white">
      <div className="border-b border-white/10 px-6 py-5">
        <div className="flex items-start justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-amber-300" strokeWidth={1.8} />
              <h1 className="text-2xl font-bold tracking-tight">Format Issues</h1>
            </div>
            <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">
              These posts were not added as clean Market Inbox opportunities because the listing or requirement format was unclear.
              Clear posts get better visibility in broker search, matching, and AI answers.
            </p>
          </div>
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="inline-flex items-center gap-2 rounded-md border border-white/10 bg-white/[0.04] px-3 py-2 text-xs font-bold text-zinc-200 hover:bg-white/[0.08] disabled:opacity-50"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? "animate-spin" : ""}`} strokeWidth={1.8} />
            Refresh
          </button>
        </div>
      </div>

      <div className="px-6 py-5">
        <div className="grid gap-3 md:grid-cols-4">
          {["Too compressed", "Mixed listing + requirement", "Missing price", "Missing location"].map((reason) => (
            <div key={reason} className="rounded-md border border-white/10 bg-white/[0.025] p-4">
              <div className="text-2xl font-bold text-white">{counts[reason] || 0}</div>
              <div className="mt-1 text-xs uppercase tracking-wider text-zinc-500">{reason}</div>
            </div>
          ))}
        </div>

        <div className="mt-5 rounded-md border border-white/10">
          <div className="border-b border-white/10 px-4 py-3">
            <div className="text-sm font-bold">Posts PropAI could not parse cleanly</div>
            <div className="mt-1 text-xs text-zinc-500">Recent WhatsApp posts that need better structure before they should become market opportunities.</div>
          </div>

          {loading ? (
            <div className="p-8 text-center text-sm text-zinc-500">Loading format issues...</div>
          ) : error ? (
            <div className="p-8 text-center text-sm text-red-300">{error}</div>
          ) : rows.length === 0 ? (
            <div className="p-8 text-center text-sm text-zinc-500">No format issues found in the latest scan.</div>
          ) : (
            <div className="divide-y divide-white/[0.06]">
              {rows.map(({ message, issue }) => (
                <div key={message.id} className="grid gap-4 px-4 py-4 lg:grid-cols-[180px_1fr_160px]">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-bold text-white">{message.broker_name || resolveSenderName(message) || "Unknown sender"}</div>
                    <div className="mt-1 truncate text-xs text-zinc-500">{displaySource(message)}</div>
                    <div className="mt-1 text-xs text-zinc-600">{displayTime(message.timestamp || message.created_at)}</div>
                  </div>

                  <div className="min-w-0">
                    <div className="mb-2 flex flex-wrap items-center gap-2">
                      <span className={`rounded border px-2 py-0.5 text-[10px] font-bold ${reasonTone(issue.reason)}`}>
                        {issue.reason}
                      </span>
                      <span className="text-xs text-zinc-500">{issue.detail}</span>
                    </div>
                    <div className="max-h-32 overflow-hidden whitespace-pre-wrap rounded-md bg-white/[0.025] p-3 text-xs leading-relaxed text-zinc-300">
                      {message.message}
                    </div>
                  </div>

                  <div className="flex items-start justify-end">
                    <Link
                      href={formatIssueHref(message)}
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#3EE88A] px-3 py-2 text-xs font-bold text-black hover:bg-[#2dd977]"
                    >
                      Open post
                      <ExternalLink className="h-3.5 w-3.5" strokeWidth={1.8} />
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
