"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Eye, RefreshCw } from "lucide-react";
import * as api from "@/lib/api";

type AuditDuplicate = {
  group_a?: { jid?: string; name?: string };
  group_b?: { jid?: string; name?: string };
  match_type?: string;
};

type LoadState = {
  groups: api.AuditGroupCard[];
  totalUniqueSenders: number;
  health: api.AuditCaptureHealth | null;
  duplicates: AuditDuplicate[];
  overlap: api.AuditGroupOverlapResponse | null;
  errors: string[];
};

const emptyState: LoadState = {
  groups: [],
  totalUniqueSenders: 0,
  health: null,
  duplicates: [],
  overlap: null,
  errors: [],
};

async function safe<T>(label: string, fn: () => Promise<T>, fallback: T): Promise<{ value: T; error?: string }> {
  try {
    return { value: await fn() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { value: fallback, error: `${label}: ${message}` };
  }
}

function timeAgo(ts?: string) {
  if (!ts) return "never";
  const ms = new Date(ts).getTime();
  if (Number.isNaN(ms)) return "unknown";
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 60) return "just now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function num(value?: number | string | null) {
  return Number(value || 0).toLocaleString("en-IN");
}

function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`rounded-lg border border-white/10 bg-white/[0.025] ${className}`}>{children}</div>;
}

function Metric({ label, value, sub }: { label: string; value: ReactNode; sub?: ReactNode }) {
  return (
    <Card className="p-4">
      <div className="text-[10px] font-bold uppercase tracking-[0.14em] text-zinc-500">{label}</div>
      <div className="mt-1 text-2xl font-bold tabular-nums text-white">{value}</div>
      {sub ? <div className="mt-1 text-[11px] leading-4 text-zinc-500">{sub}</div> : null}
    </Card>
  );
}

function SectionTitle({ icon, title, sub }: { icon?: ReactNode; title: string; sub?: string }) {
  return (
    <div className="flex items-start gap-2">
      {icon ? <div className="mt-0.5 text-[#3EE88A]">{icon}</div> : null}
      <div>
        <h2 className="text-sm font-bold text-white">{title}</h2>
        {sub ? <p className="mt-1 text-xs leading-5 text-zinc-500">{sub}</p> : null}
      </div>
    </div>
  );
}

export default function AuditPage() {
  const [state, setState] = useState<LoadState>(emptyState);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    const [groupsResp, health, duplicates, overlap] = await Promise.all([
      safe("group audit", () => api.getAuditGroups(), { groups: [] as api.AuditGroupCard[], total_unique_senders: 0 }),
      safe("capture health", () => api.getAuditCaptureHealth(), null as api.AuditCaptureHealth | null),
      safe("duplicate groups", () => api.getAuditDuplicates(), [] as AuditDuplicate[]),
      safe("member overlap", () => api.getAuditGroupOverlap(), { pairs: [], groups: [] }),
    ]);

    const groupsData = groupsResp.value;
    setState({
      groups: groupsData.groups,
      totalUniqueSenders: groupsData.total_unique_senders,
      health: health.value,
      duplicates: duplicates.value,
      overlap: overlap.value,
      errors: [groupsResp.error, health.error, duplicates.error, overlap.error].filter(Boolean) as string[],
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      void load();
    }, 0);
    return () => window.clearTimeout(timer);
  }, [load]);

  const totalMessages = state.groups.reduce((sum, g) => sum + (g.messages || 0), 0);
  const totalObservations = state.groups.reduce((sum, g) => sum + (g.observations || 0), 0);
  const totalListings = state.groups.reduce((sum, g) => sum + (g.listings || 0), 0);
  const lowCoverageGroups = state.groups.filter((g) => (g.coverage || 0) < 70).length;
  const duplicateCount = state.duplicates.length;
  const overlapPairs = state.overlap?.pairs || [];
  const chaosScore = Math.min(100, Math.round((lowCoverageGroups * 10) + (duplicateCount * 12) + (state.groups.length > 0 ? Math.max(0, 40 - Math.round((totalObservations / Math.max(1, state.groups.length)) / 2)) : 40)));

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-6 py-6 text-white">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">WhatsApp Audit</div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">Group Intelligence</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            What your WhatsApp groups are producing: opportunities, members, signals, and parser controls.
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

      {state.errors.length > 0 && (
        <Card className="border-amber-500/20 bg-amber-500/10 p-4">
          <div className="flex gap-2 text-sm font-bold text-amber-100">
            <AlertTriangle className="h-4 w-4" strokeWidth={1.8} />
            Some endpoints returned errors.
          </div>
          <div className="mt-2 space-y-1 text-xs text-amber-100/75">
            {state.errors.slice(0, 3).map((error) => <div key={error}>{error}</div>)}
          </div>
        </Card>
      )}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric label="Capture Status" value={state.health?.last_webhook ? "Live" : "No Data"} sub={`Last webhook ${timeAgo(state.health?.last_webhook)}`} />
        <Metric label="Groups Monitored" value={num(state.groups.length)} sub="All detected groups" />
        <Metric label="Messages Captured" value={num(totalMessages)} sub={`${num(state.health?.total_parsed_today)} parsed today`} />
        <Metric label="Parser Queue" value={num(state.health?.queue_backlog)} sub={`${num(state.health?.queue_backlog || 0)} pending`} />
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric label="Unique Members" value={num(state.totalUniqueSenders)} sub="Total unique senders across all groups" />
        <Metric label="Observations" value={num(totalObservations)} sub="Parsed opportunities extracted" />
        <Metric label="Listings" value={num(totalListings)} sub="Property listings identified" />
        <Metric label="Active Groups" value={num(state.groups.filter((g) => g.status === "live").length)} sub={`of ${state.groups.length} total groups`} />
      </section>

      <section className="grid gap-3 md:grid-cols-3">
        <Metric
          label="Chaos Score"
          value={`${chaosScore}%`}
          sub="Higher means more noise, duplication, and mixed-quality groups"
        />
        <Metric
          label="Low Coverage Groups"
          value={num(lowCoverageGroups)}
          sub="Groups with weak extraction coverage"
        />
        <Metric
          label="Duplicate Candidates"
          value={num(duplicateCount)}
          sub="Possible name-collision groups"
        />
      </section>

      <section>
        <SectionTitle
          icon={<Eye className="h-4 w-4" strokeWidth={1.8} />}
          title="Group Audit"
          sub="Which groups create useful market signal."
        />
        <Card className="mt-3 overflow-hidden">
          <div className="grid grid-cols-[minmax(220px,1.4fr)_90px_90px_90px_92px] gap-3 border-b border-white/10 px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-zinc-500">
            <div>Group</div>
            <div>Signal</div>
            <div>Members</div>
            <div>Freshness</div>
            <div>Messages</div>
          </div>
          {state.groups.length === 0 ? (
            <div className="px-4 py-10 text-center text-sm text-zinc-500">
              No group data loaded yet. Once WhatsApp sync captures group messages, this page will populate.
            </div>
          ) : state.groups.map((group) => (
            <div key={group.jid} className="grid grid-cols-[minmax(220px,1.4fr)_90px_90px_90px_92px] gap-3 border-b border-white/[0.06] px-4 py-3 text-xs last:border-b-0">
              <div className="min-w-0">
                <div className="truncate font-semibold text-white">{group.name}</div>
                <div className="mt-1 line-clamp-1 text-[11px] text-zinc-500">
                  {num(group.observations)} observations · {num(group.markets_count)} markets
                </div>
              </div>
              <div>
                <div className="font-mono font-semibold text-[#3EE88A]">{num(group.listings)}</div>
                <div className="text-[10px] text-zinc-500">{num(group.requirements)} reqs</div>
              </div>
              <div>
                <div className="font-mono font-semibold text-white">{num(group.senders_count)}</div>
                <div className="text-[10px] text-zinc-500">{num(group.active_brokers)} brokers</div>
              </div>
              <div className="text-zinc-400">{timeAgo(group.last_activity)}</div>
              <div className="font-mono font-semibold text-zinc-200">{num(group.messages)}</div>
            </div>
          ))}
        </Card>
      </section>

      <section>
        <SectionTitle
          icon={<AlertTriangle className="h-4 w-4" strokeWidth={1.8} />}
          title="Duplicate Group Heat"
          sub="These are likely collisions or mirrored group names that make the market noisier."
        />
        <Card className="mt-3 overflow-hidden">
          {state.duplicates.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              No duplicate candidates found yet. Once the group graph is healthy, this section will show overlapping groups.
            </div>
          ) : (
            <div className="divide-y divide-white/10">
              {state.duplicates.slice(0, 8).map((dup, index: number) => (
                <div key={`${dup.group_a?.jid || index}-${dup.group_b?.jid || index}`} className="grid gap-3 px-4 py-3 md:grid-cols-[1.1fr_1.1fr_0.8fr]">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">Group A</div>
                    <div className="mt-1 text-sm font-semibold text-white">{dup.group_a?.name || dup.group_a?.jid || "Unknown"}</div>
                    <div className="text-[11px] text-zinc-500">{dup.group_a?.jid || "—"}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">Group B</div>
                    <div className="mt-1 text-sm font-semibold text-white">{dup.group_b?.name || dup.group_b?.jid || "Unknown"}</div>
                    <div className="text-[11px] text-zinc-500">{dup.group_b?.jid || "—"}</div>
                  </div>
                  <div className="flex items-end md:justify-end">
                    <span className="inline-flex rounded-full border border-amber-500/30 bg-amber-500/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-200">
                      {dup.match_type || "duplicate"}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>

      <section>
        <SectionTitle
          icon={<Eye className="h-4 w-4" strokeWidth={1.8} />}
          title="Member Overlap Recommendations"
          sub="PropAI can show which groups share the most members so you do not parse the same crowd twice."
        />
        <Card className="mt-3 overflow-hidden">
          {overlapPairs.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm text-zinc-500">
              No high-overlap group pairs found yet. Once more messages are captured, this will rank redundant groups by shared senders.
            </div>
          ) : (
            <div className="divide-y divide-white/10">
              {overlapPairs.slice(0, 8).map((pair, index) => (
                <div key={`${pair.group_a.jid}-${pair.group_b.jid}-${index}`} className="grid gap-3 px-4 py-3 md:grid-cols-[1.1fr_1.1fr_0.8fr_0.9fr]">
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">Keep</div>
                    <div className="mt-1 text-sm font-semibold text-white">{pair.keep.name}</div>
                    <div className="text-[11px] text-zinc-500">{pair.keep.jid} · {num(pair.keep.senders)} senders</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">Skip</div>
                    <div className="mt-1 text-sm font-semibold text-white">{pair.skip.name}</div>
                    <div className="text-[11px] text-zinc-500">{pair.skip.jid} · {num(pair.skip.senders)} senders</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-[0.16em] text-zinc-500">Shared members</div>
                    <div className="mt-1 text-xl font-bold text-[#3EE88A]">{num(pair.shared_senders)}</div>
                    <div className="text-[11px] text-zinc-500">{pair.reason}</div>
                  </div>
                  <div className="flex items-end md:justify-end">
                    <span className="inline-flex rounded-full border border-[#3EE88A]/30 bg-[#3EE88A]/10 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-[#3EE88A]">
                      {pair.overlap_pct}% overlap
                    </span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <Card className="p-4">
          <SectionTitle title="Parser Controls" />
          <p className="mt-3 text-xs leading-5 text-zinc-500">
            PropAI now parses broker groups directly. The old opt-out privacy workflow has been removed.
          </p>
        </Card>
        <Card className="p-4">
          <SectionTitle title="Format Pressure" />
          <p className="mt-3 text-xs leading-5 text-zinc-500">
            Posts that need more detail stay visible in Market Inbox with inline tags showing what is missing.
          </p>
          <Link href="/inbox" className="mt-4 inline-flex text-xs font-bold text-[#3EE88A] hover:text-white">
            Review in market inbox
          </Link>
        </Card>
        <Card className="p-4">
          <SectionTitle title="Market Inbox Output" />
          <p className="mt-3 text-xs leading-5 text-zinc-500">
            Clean group output should become broker/entity opportunities in Market Inbox. No free public feed: value starts after WhatsApp is connected.
          </p>
          <Link href="/inbox" className="mt-4 inline-flex text-xs font-bold text-[#3EE88A] hover:text-white">
            Open market inbox
          </Link>
        </Card>
      </section>
    </div>
  );
}
