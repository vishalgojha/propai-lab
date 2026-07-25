"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState } from "react";
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ShieldAlert,
  ShieldCheck,
  Skull,
  Trash2,
  TrendingUp,
  X,
  Zap,
} from "lucide-react";
import * as api from "@/lib/api";
import { cleanGroupName } from "@/lib/whatsapp-display";

const RECO_CONFIG: Record<string, { label: string; color: string; icon: React.ReactNode }> = {
  safe_exit: {
    label: "Safe to exit",
    color: "border-red-500/30 bg-red-500/10 text-red-300",
    icon: <Skull className="h-3 w-3" />,
  },
  probably_exit: {
    label: "Probably safe",
    color: "border-amber-500/30 bg-amber-500/10 text-amber-300",
    icon: <ShieldAlert className="h-3 w-3" />,
  },
  noise: {
    label: "Noise",
    color: "border-zinc-500/30 bg-zinc-500/10 text-zinc-400",
    icon: <X className="h-3 w-3" />,
  },
  low_value: {
    label: "Low value",
    color: "border-zinc-400/30 bg-zinc-400/10 text-zinc-300",
    icon: <ShieldAlert className="h-3 w-3" />,
  },
  keep: {
    label: "Keep",
    color: "border-emerald-500/30 bg-emerald-500/10 text-emerald-300",
    icon: <ShieldCheck className="h-3 w-3" />,
  },
  essential: {
    label: "Essential",
    color: "border-[#3EE88A]/30 bg-[#3EE88A]/10 text-[#3EE88A]",
    icon: <Zap className="h-3 w-3" />,
  },
};

function ActivityBar({ current, max }: { current: number; max: number }) {
  const pct = max > 0 ? Math.min(100, (current / max) * 100) : 0;
  return (
    <div className="flex h-1.5 w-full items-center">
      <div className="h-full w-full overflow-hidden rounded-full bg-white/5">
        <div
          className="h-full rounded-full bg-[#3EE88A]/60 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

export default function GroupsPage() {
  const [healthData, setHealthData] = useState<{ groups: any[]; summary: any } | null>(null);
  const [legacyGroups, setLegacyGroups] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [optOutEntries, setOptOutEntries] = useState<string[]>([]);
  const [optOutDraft, setOptOutDraft] = useState("");
  const [savingOptOut, setSavingOptOut] = useState(false);
  const [optOutMessage, setOptOutMessage] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [expandedGroup, setExpandedGroup] = useState<string | null>(null);
  const [members, setMembers] = useState<Record<string, any[]>>({});
  const [loadingMembers, setLoadingMembers] = useState<string | null>(null);

  const matchesOptOut = (name: string, entries: string[]) =>
    entries.some((e) => name.toLowerCase().includes(e.trim().toLowerCase()));

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [health, optOut, legacy] = await Promise.all([
        api.getGroupsHealth(),
        api.getOptOutList(),
        api.getGroups(),
      ]);
      setHealthData(health);
      setLegacyGroups(legacy);
      setOptOutEntries(optOut);
      setError(null);
    } catch (err) {
      setError("Could not load groups right now.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const syncOptOut = (entries: string[]) => {
    const normalized = Array.from(new Set(entries.map((e) => e.trim()).filter(Boolean)));
    setOptOutEntries(normalized);
    return normalized;
  };

  const applyOptOut = async (entries: string[], msg?: string) => {
    setSavingOptOut(true);
    setOptOutMessage(null);
    try {
      const normalized = Array.from(new Set(entries.map((e) => e.trim()).filter(Boolean)));
      await api.setOptOutList(normalized);
      syncOptOut(normalized);
      setOptOutMessage(msg || (normalized.length ? "Opt-out list saved." : "Opt-out list cleared."));
    } catch (err) {
      setOptOutMessage(err instanceof Error ? err.message : "Could not save opt-out list.");
    } finally {
      setSavingOptOut(false);
    }
  };

  const addOptOut = async () => {
    const next = [...optOutEntries, ...optOutDraft.split(/[\n,]/g).map((e) => e.trim()).filter(Boolean)];
    setOptOutDraft("");
    await applyOptOut(next);
  };

  const removeOptOut = async (entry: string) => {
    await applyOptOut(optOutEntries.filter((e) => e !== entry));
  };

  const toggleMembers = async (name: string) => {
    if (expandedGroup === name) {
      setExpandedGroup(null);
      return;
    }
    setExpandedGroup(name);
    if (!members[name]) {
      setLoadingMembers(name);
      try {
        const match = legacyGroups.find((g) => g.name === name);
        const jid = match?.jid || "";
        const data = jid ? await api.getGroupMembers(jid) : [];
        setMembers((prev) => ({ ...prev, [name]: data }));
      } catch {
        setMembers((prev) => ({ ...prev, [name]: [] }));
      } finally {
        setLoadingMembers(null);
      }
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center p-12 text-sm text-zinc-500">
        Loading group intelligence...
      </div>
    );
  }

  const groups = healthData?.groups || [];
  const summary = healthData?.summary || {};
  const max7d = Math.max(1, ...groups.map((g: any) => g.msgs_7d || 0));
  const filtered = filter === "all" ? groups : groups.filter((g: any) => g.recommendation === filter);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-bold">Group Intelligence</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Which groups are worth staying in — and which you can confidently exit.
        </p>
      </div>

      {error && (
        <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
          {error}
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        {[
          ["Total", summary.total || 0, "text-white"],
          ["Safe to exit", summary.safe_exit || 0, "text-red-400"],
          ["Probably exit", summary.probably_exit || 0, "text-amber-400"],
          ["Noise", summary.noise || 0, "text-zinc-400"],
          ["Keep", summary.keep || 0, "text-emerald-400"],
          ["Essential", summary.essential || 0, "text-[#3EE88A]"],
        ].map(([label, value, cls]) => (
          <div key={label as string} className="rounded-xl border border-white/10 bg-zinc-900 p-3">
            <div className={`text-2xl font-bold tabular-nums ${cls}`}>{value as number}</div>
            <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label as string}</div>
          </div>
        ))}
      </div>

      {/* Market value bar */}
      <div className="rounded-xl border border-white/10 bg-zinc-900 p-4">
        <div className="flex flex-wrap items-center gap-6 text-sm">
          <div>
            <span className="text-zinc-500">Messages (7d): </span>
            <span className="font-semibold text-white tabular-nums">{(summary.total_7d || 0).toLocaleString()}</span>
          </div>
          <div>
            <span className="text-zinc-500">Messages (30d): </span>
            <span className="font-semibold text-white tabular-nums">{(summary.total_30d || 0).toLocaleString()}</span>
          </div>
          <div>
            <span className="text-zinc-500">Listings extracted: </span>
            <span className="font-semibold text-white tabular-nums">{(summary.total_listings || 0).toLocaleString()}</span>
          </div>
          <div>
            <span className="text-zinc-500">Requirements: </span>
            <span className="font-semibold text-white tabular-nums">{(summary.total_requirements || 0).toLocaleString()}</span>
          </div>
        </div>
      </div>

      {/* Filter tabs */}
      <div className="flex flex-wrap gap-2">
        {["all", "safe_exit", "probably_exit", "noise", "low_value", "keep", "essential"].map((f) => {
          const cfg = f === "all" ? { label: `All (${summary.total || 0})`, color: "border-white/20 text-white" } : RECO_CONFIG[f];
          const count = f === "all" ? summary.total : (summary[f] || 0);
          const active = filter === f;
          return (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={`inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium transition ${
                active
                  ? "border-[#3EE88A]/40 bg-[#3EE88A]/15 text-[#3EE88A]"
                  : "border-white/10 bg-white/[0.03] text-zinc-400 hover:bg-white/[0.06]"
              }`}
            >
              {cfg && "icon" in cfg && cfg.icon}
              {f === "all" ? "All" : cfg?.label || f}
              <span className="tabular-nums opacity-60">{count}</span>
            </button>
          );
        })}
      </div>

      {/* Groups table */}
      {filtered.length === 0 ? (
        <div className="text-sm text-zinc-500">No groups match this filter.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-white/10">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-white/10 bg-zinc-900/50">
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-wider text-zinc-500">Group</th>
                <th className="px-3 py-2.5 text-left text-[10px] uppercase tracking-wider text-zinc-500">Activity (7d)</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-wider text-zinc-500">30d</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-wider text-zinc-500">Brokers</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-wider text-zinc-500">Listings</th>
                <th className="px-3 py-2.5 text-right text-[10px] uppercase tracking-wider text-zinc-500">Last msg</th>
                <th className="px-3 py-2.5 text-center text-[10px] uppercase tracking-wider text-zinc-500">Verdict</th>
                <th className="px-3 py-2.5 text-center text-[10px] uppercase tracking-wider text-zinc-500">Parse</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((g: any, i: number) => {
                const reco = RECO_CONFIG[g.recommendation] || RECO_CONFIG.keep;
                const isExcluded = matchesOptOut(g.name, optOutEntries);
                const isExpanded = expandedGroup === g.name;
                const groupMembers = members[g.name] || [];
                const isLoadingM = loadingMembers === g.name;
                return (
                  <tr key={g.name || i} className="border-b border-white/5 hover:bg-white/[0.02]">
                    <td className="max-w-[260px] px-3 py-2">
                      <div className="font-medium text-white truncate" title={g.name}>
                        {cleanGroupName(g.name)}
                      </div>
                      <div className="mt-0.5 text-[10px] text-zinc-600">
                        {g.total?.toLocaleString()} total messages
                      </div>
                    </td>
                    <td className="px-3 py-2">
                      <div className="w-32">
                        <ActivityBar current={g.msgs_7d} max={max7d} />
                        <div className="mt-1 text-[10px] tabular-nums text-zinc-500">
                          {g.msgs_7d?.toLocaleString()}/wk
                        </div>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                      {(g.msgs_30d || 0).toLocaleString()}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        onClick={() => void toggleMembers(g.name)}
                        className="text-zinc-300 hover:text-white transition-colors"
                      >
                        <span className="inline-flex items-center gap-1 tabular-nums">
                          {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                          {g.senders || "—"}
                        </span>
                      </button>
                      {isExpanded && (
                        <div className="mt-2 max-h-48 overflow-y-auto rounded-lg border border-white/10 bg-black/30 p-2">
                          {isLoadingM ? (
                            <div className="text-xs text-zinc-500 py-1">Loading...</div>
                          ) : groupMembers.length === 0 ? (
                            <div className="text-xs text-zinc-600 py-1">No member data</div>
                          ) : (
                            <div className="flex flex-wrap gap-1">
                              {groupMembers.map((m: any, idx: number) => (
                                <span
                                  key={m.phone || m.name || idx}
                                  className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs ${
                                    m.is_admin
                                      ? "border border-[#3EE88A]/20 bg-[#3EE88A]/10 text-[#9ff7bf]"
                                      : "border border-white/10 bg-white/[0.04] text-zinc-400"
                                  }`}
                                >
                                  {m.name}
                                  {m.is_admin && <span className="text-[9px] text-[#3EE88A]">admin</span>}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-300">
                      {g.listings > 0 ? (
                        <span className="inline-flex items-center gap-1">
                          <TrendingUp className="h-3 w-3 text-emerald-500" />
                          {g.listings}
                        </span>
                      ) : (
                        <span className="text-zinc-600">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right text-xs text-zinc-500">
                      {g.days_since_msg === 0 ? (
                        <span className="text-emerald-500">today</span>
                      ) : g.days_since_msg < 7 ? (
                        <span>{g.days_since_msg}d ago</span>
                      ) : g.days_since_msg < 30 ? (
                        <span className="text-amber-500">{g.days_since_msg}d ago</span>
                      ) : (
                        <span className="text-red-400">{g.days_since_msg}d ago</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-center">
                      <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-medium ${reco.color}`}>
                        {reco.icon}
                        {reco.label}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-center">
                      <button
                        type="button"
                        onClick={() => void removeOptOut(g.name)}
                        disabled={savingOptOut || !isExcluded}
                        className={`rounded-md px-2 py-1 text-[11px] font-semibold transition disabled:opacity-40 ${
                          isExcluded
                            ? "border border-white/10 bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08]"
                            : "border border-[#3EE88A]/20 bg-[#3EE88A]/10 text-[#9ff7bf]"
                        }`}
                      >
                        {isExcluded ? "Re-track" : "Tracked"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Opt-out section */}
      <div className="rounded-2xl border border-white/10 bg-zinc-950 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500">Opt-out list</div>
            <h3 className="mt-2 text-sm font-semibold text-white">Groups excluded from parsing</h3>
            <p className="mt-1 text-xs leading-5 text-zinc-500">
              Add a group name or fragment. Matching groups will be skipped from extraction.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void applyOptOut([])}
            disabled={savingOptOut || optOutEntries.length === 0}
            className="inline-flex items-center gap-2 rounded-md border border-white/10 px-3 py-2 text-xs font-semibold text-zinc-300 transition hover:bg-white/[0.04] disabled:opacity-40"
          >
            <Trash2 className="h-3.5 w-3.5" /> Clear all
          </button>
        </div>

        <div className="mt-4 flex flex-col gap-2 sm:flex-row">
          <input
            value={optOutDraft}
            onChange={(e) => setOptOutDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                void addOptOut();
              }
            }}
            placeholder="Group names or fragments, separated by commas"
            className="h-9 flex-1 rounded-md border border-white/10 bg-black px-3 text-sm text-white outline-none placeholder:text-zinc-600 focus:border-[#3EE88A]/40"
          />
          <button
            type="button"
            onClick={() => void addOptOut()}
            disabled={savingOptOut || !optOutDraft.trim()}
            className="inline-flex h-9 items-center justify-center rounded-md bg-[#3EE88A] px-4 text-sm font-semibold text-black transition hover:bg-[#35d47c] disabled:opacity-40"
          >
            Add
          </button>
        </div>

        {optOutEntries.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {optOutEntries.map((entry) => (
              <button
                key={entry}
                type="button"
                onClick={() => void removeOptOut(entry)}
                disabled={savingOptOut}
                className="inline-flex items-center gap-1.5 rounded-full border border-red-500/20 bg-red-500/10 px-2.5 py-1 text-xs font-medium text-red-300 transition hover:bg-red-500/15 disabled:opacity-40"
              >
                {entry}
                <X className="h-3 w-3" />
              </button>
            ))}
          </div>
        )}

        {optOutMessage && (
          <div className="mt-3 flex items-center gap-2 text-xs text-zinc-400">
            <CheckCircle2 className="h-3.5 w-3.5 text-[#3EE88A]" />
            {optOutMessage}
          </div>
        )}
      </div>
    </div>
  );
}
