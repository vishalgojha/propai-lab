"use client";

export const dynamic = "force-dynamic";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { CheckCircle2, MessageSquare, Plus, Trash2, X } from "lucide-react";
import * as api from "@/lib/api";
import { cleanGroupName, stripDecorativeEmoji } from "@/lib/whatsapp-display";

export default function GroupsPage() {
  const [groups, setGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [optOutEntries, setOptOutEntries] = useState<string[]>([]);
  const [optOutDraft, setOptOutDraft] = useState("");
  const [savingOptOut, setSavingOptOut] = useState(false);
  const [optOutMessage, setOptOutMessage] = useState<string | null>(null);

  const groupIdentity = (group: any) => String(group.jid || group.id || group.name || "").trim();
  const matchesOptOutEntry = (group: any, entry: string) => {
    const needle = entry.trim().toLowerCase();
    if (!needle) return false;
    const identity = groupIdentity(group).toLowerCase();
    const name = String(group.name || "").toLowerCase();
    return identity === needle || name.includes(needle);
  };
  const isGroupExcluded = (group: any, entries: string[]) => entries.some((entry) => matchesOptOutEntry(group, entry));
  const optOutLabelFor = (entry: string) => {
    const needle = entry.trim().toLowerCase();
    if (!needle) return entry;
    const exact = groups.find((group) => groupIdentity(group).toLowerCase() === needle);
    if (exact?.name) return cleanGroupName(exact.name);
    const fragment = groups.find((group) => String(group.name || "").toLowerCase().includes(needle));
    if (fragment?.name) return cleanGroupName(fragment.name);
    return stripDecorativeEmoji(entry);
  };

  const optOutHintFor = (entry: string) => {
    const needle = entry.trim().toLowerCase();
    if (!needle) return "Opt-out entry";
    const exact = groups.find((group) => groupIdentity(group).toLowerCase() === needle);
    if (exact?.name) return `Opt-out entry matched by exact ID: ${entry}`;
    const fragment = groups.find((group) => String(group.name || "").toLowerCase().includes(needle));
    if (fragment?.name) return `Opt-out entry matched by name fragment: ${entry}`;
    return `Stored opt-out entry: ${entry}`;
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const access = await api.getMarketAccessStatus();
      setWhatsappConnected(access.whatsapp_connected);
      if (!access.whatsapp_connected) {
        setGroups([]);
        setOptOutEntries([]);
        setLoading(false);
        return;
      }

      const [data, optOut] = await Promise.all([
        api.getGroups(),
        api.getOptOutList(),
      ]);
      setGroups(data);
      setOptOutEntries(optOut);
      setError(null);
    } catch (err) {
      setError("Could not load WhatsApp groups right now.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const access = await api.getMarketAccessStatus();
        if (cancelled) return;
        setWhatsappConnected(access.whatsapp_connected);
        if (!access.whatsapp_connected) {
          setGroups([]);
          setOptOutEntries([]);
          setLoading(false);
          return;
        }

        const [data, optOut] = await Promise.all([api.getGroups(), api.getOptOutList()]);
        if (cancelled) return;
        setGroups(data);
        setOptOutEntries(optOut);
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
  const optedOutCount = optOutEntries.length;
  const trackedCount = groups.filter((g) => !g.excluded).length;
  const showConnectPrompt = whatsappConnected === false;

  const syncOptOutEntries = (entries: string[]) => {
    const normalized = Array.from(new Set(entries.map((entry) => entry.trim()).filter(Boolean)));
    setOptOutEntries(normalized);
    setGroups((current) =>
      current.map((group) => {
        const excluded = isGroupExcluded(group, normalized);
        return { ...group, allowed: !excluded, excluded };
      }),
    );
    return normalized;
  };

  const applyOptOutEntries = async (entries: string[], successMessage?: string) => {
    setSavingOptOut(true);
    setOptOutMessage(null);
    try {
      const normalized = Array.from(new Set(entries.map((entry) => entry.trim()).filter(Boolean)));
      await api.setOptOutList(normalized);
      syncOptOutEntries(normalized);
      setOptOutMessage(successMessage || (normalized.length ? "Opt-out list saved." : "Opt-out list cleared."));
    } catch (err) {
      setOptOutMessage(err instanceof Error ? err.message : "Could not save opt-out list.");
    } finally {
      setSavingOptOut(false);
    }
  };

  const addOptOutEntries = async () => {
    const next = [
      ...optOutEntries,
      ...optOutDraft
        .split(/[\n,]/g)
        .map((entry) => entry.trim())
        .filter(Boolean),
    ];
    setOptOutDraft("");
    await applyOptOutEntries(next);
  };

  const removeOptOutEntry = async (entry: string) => {
    await applyOptOutEntries(optOutEntries.filter((item) => item !== entry));
  };

  const toggleGroupOptOut = async (groupId: string, excluded: boolean) => {
    const next = excluded
      ? optOutEntries.filter((entry) => entry !== groupId)
      : [...optOutEntries, groupId];
    await applyOptOutEntries(next, excluded ? "Group will now be tracked." : "Group added to opt-out list.");
  };

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
      <h2 className="mb-4 text-lg font-bold">Groups</h2>
      {error && (
        <div className="mb-4 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          {error}
        </div>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
        {[
          ["Groups", groups.length],
          ["Tagged", parsedGroupCount],
          ["Tracked", trackedCount],
          ["Opt-outs", optedOutCount],
          ["Capture", "Live"],
          ["Window", "10-7"],
        ].map(([label, value]) => (
          <div key={label as string} className="rounded-xl border border-white/10 bg-zinc-900 p-3">
            <div className="text-2xl font-bold text-white">{value as number | string}</div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label as string}</div>
          </div>
        ))}
      </div>
      <div className="mb-4 grid gap-3 xl:grid-cols-[1.2fr_.8fr]">
        <div className="rounded-2xl border border-white/10 bg-zinc-950 p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Opt-out list</div>
              <h3 className="mt-2 text-base font-semibold text-white">Groups that should not be parsed</h3>
              <p className="mt-1 text-sm leading-6 text-zinc-500">
                Add a group JID or a name fragment. Matching groups will be skipped, but everything else stays on.
              </p>
            </div>
            <button
              type="button"
              onClick={() => void applyOptOutEntries([])}
              disabled={savingOptOut || optOutEntries.length === 0}
              className="inline-flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/[0.04] disabled:opacity-40"
            >
              <Trash2 className="h-3.5 w-3.5" /> Clear
            </button>
          </div>

          <div className="mt-4 flex flex-col gap-2 sm:flex-row">
            <input
              value={optOutDraft}
              onChange={(event) => setOptOutDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void addOptOutEntries();
                }
              }}
              placeholder="Paste group JIDs or fragments, separated by commas"
              className="h-10 flex-1 rounded-md border border-white/10 bg-black px-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-[#3EE88A]/40"
            />
            <button
              type="button"
              onClick={() => void addOptOutEntries()}
              disabled={savingOptOut || !optOutDraft.trim()}
              className="inline-flex h-10 items-center justify-center gap-2 rounded-md bg-[#3EE88A] px-4 text-sm font-semibold text-black transition hover:bg-[#35d47c] disabled:opacity-40"
            >
              <Plus className="h-4 w-4" /> Add
            </button>
          </div>

          <div className="mt-4 flex flex-wrap gap-2">
            {optOutEntries.length === 0 ? (
              <div className="text-sm text-zinc-600">No opt-outs configured.</div>
            ) : (
              optOutEntries.map((entry) => (
                <button
                  key={entry}
                  type="button"
                  onClick={() => void removeOptOutEntry(entry)}
                  disabled={savingOptOut}
                  className="inline-flex items-center gap-2 rounded-full border border-[#3EE88A]/20 bg-[#3EE88A]/10 px-3 py-1.5 text-xs font-medium text-[#9ff7bf] transition hover:bg-[#3EE88A]/15 disabled:opacity-40"
                  title={optOutHintFor(entry)}
                >
                  {optOutLabelFor(entry)}
                  <X className="h-3 w-3" />
                </button>
              ))
            )}
          </div>

          {optOutMessage ? (
            <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
              <CheckCircle2 className="h-3.5 w-3.5 text-[#3EE88A]" />
              {optOutMessage}
            </div>
          ) : null}
        </div>

        <div className="rounded-2xl border border-white/10 bg-zinc-950 p-4">
          <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Meaning</div>
          <div className="mt-2 text-sm font-semibold text-white">Opt-out, not allowlist</div>
          <p className="mt-2 text-sm leading-6 text-zinc-500">
            PropAI tracks all connected groups by default. Put noisy or private groups on the opt-out list to exclude them from parsing.
          </p>
        </div>
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
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Parse</th>
              </tr>
            </thead>
            <tbody>
              {groups.map((g: any, i: number) => (
                <tr key={g.id || i} className="hover:bg-zinc-900">
                  <td className="px-2.5 py-2 border-b border-white/10 font-semibold">{cleanGroupName(g.name)}</td>
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
                    <div className="flex flex-wrap items-center gap-2">
                    {isGroupExcluded(g, optOutEntries) || g.excluded ? (
                      <span className="badge badge-danger">opted out</span>
                    ) : (
                      <span className="badge badge-success">tracked</span>
                    )}
                      <button
                        type="button"
                        onClick={() => void toggleGroupOptOut(groupIdentity(g), Boolean(isGroupExcluded(g, optOutEntries) || g.excluded))}
                        disabled={savingOptOut}
                        className={`rounded-md px-2.5 py-1 text-[11px] font-semibold transition disabled:opacity-40 ${
                          isGroupExcluded(g, optOutEntries) || g.excluded
                            ? "border border-[#3EE88A]/20 bg-[#3EE88A]/10 text-[#9ff7bf] hover:bg-[#3EE88A]/15"
                            : "border border-white/10 bg-white/[0.04] text-zinc-200 hover:bg-white/[0.08]"
                        }`}
                      >
                        {isGroupExcluded(g, optOutEntries) || g.excluded ? "Track" : "Opt out"}
                      </button>
                    </div>
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
