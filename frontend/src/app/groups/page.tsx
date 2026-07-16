"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useEffect, useState } from "react";
import { MessageSquare } from "lucide-react";
import * as api from "@/lib/api";

export default function GroupsPage() {
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const access = await api.getMarketAccessStatus();
        if (cancelled) return;
        setWhatsappConnected(access.whatsapp_connected);
        if (!access.whatsapp_connected) {
          setLoading(false);
          return;
        }

        const data = await api.getGroups();
        if (cancelled) return;
        setGroups(data);
      } catch (err) {
        if (cancelled) return;
        setError("Could not load WhatsApp groups right now.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const parsedGroupCount = groups.filter((g) => g.parsed?.is_real_estate || g.parsed?.markets?.length || g.parsed?.segments?.length).length;
  const showConnectPrompt = whatsappConnected === false;

  if (loading) {
    return <div className="p-6 text-sm text-zinc-500">Checking WhatsApp connection...</div>;
  }

  if (showConnectPrompt) {
    return (
      <div className="mx-auto max-w-2xl px-4 py-10">
        <div className="rounded-2xl border border-white/10 bg-zinc-950 p-6 text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-[#3EE88A]/30 bg-[#3EE88A]/10 text-[#3EE88A]">
            <MessageSquare className="h-5 w-5" strokeWidth={1.6} />
          </div>
          <h2 className="text-xl font-bold text-white">Scan WhatsApp QR to view groups</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-zinc-500">
            WhatsApp is not connected yet. Open the Connection Center, scan the QR code, and then return here to see your raw WhatsApp groups.
          </p>
          <div className="mt-5 flex flex-col items-center justify-center gap-2 sm:flex-row">
            <Link
              href="/connections"
              className="inline-flex h-10 items-center justify-center rounded-lg bg-[#3EE88A] px-5 text-sm font-bold text-black hover:bg-[#35d47c]"
            >
              Open QR
            </Link>
            <Link
              href="/connections"
              className="inline-flex h-10 items-center justify-center rounded-lg border border-white/10 bg-zinc-900 px-5 text-sm font-bold text-zinc-200 hover:border-[#3EE88A]/40 hover:text-[#3EE88A]"
            >
              Open Connection Center
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Groups</h2>
      {error && (
        <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          {error}
        </div>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        {[
          ["Groups", groups.length],
          ["Tagged", parsedGroupCount],
          ["Capture", "Live"],
          ["Window", "10-7"],
        ].map(([label, value]) => (
          <div key={label as string} className="bg-zinc-900 border border-white/10 rounded-xl p-3">
            <div className="text-2xl font-bold text-white">{value as number | string}</div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label as string}</div>
          </div>
        ))}
      </div>
      {groups.length > 0 && (
        <div className="mb-4 border border-white/10 bg-zinc-900 text-zinc-400 rounded-xl px-4 py-3 text-sm">
          PropAI tracks new WhatsApp group activity during 10 AM - 7 PM IST.
        </div>
      )}
      {groups.length === 0 ? (
        <div className="text-zinc-500">No groups connected yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Name</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Tags</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Members</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Mode</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g: any, i: number) => (
                <tr key={g.id || i} className="hover:bg-zinc-900">
                  <td className="px-2.5 py-2 border-b border-white/10 font-semibold">{g.name}</td>
                  <td className="px-2.5 py-2 border-b border-white/10">
                    <div className="flex flex-wrap gap-1">
                      {[...(g.parsed?.markets || []), ...(g.parsed?.segments || [])].length === 0
                        ? "—"
                        : [...(g.parsed?.markets || []), ...(g.parsed?.segments || [])].map((tag: string) => (
                            <span key={tag} className="badge badge-neutral">
                              {tag}
                            </span>
                          ))}
                    </div>
                  </td>
                  <td className="px-2.5 py-2 border-b border-white/10">{g.participants ?? "—"}</td>
                  <td className="px-2.5 py-2 border-b border-white/10">
                    <span className="badge badge-success">live</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
