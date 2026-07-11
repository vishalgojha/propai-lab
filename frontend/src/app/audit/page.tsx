"use client";

export const dynamic = 'force-dynamic';

import { useCallback, useEffect, useState } from "react";
import * as api from "@/lib/api";

type LatestRecord = {
  id: number | string;
  time: string;
  conversation: string;
  sender: string;
  preview: string;
  stored?: boolean;
};

type LearnedTerm = {
  term: string;
  learned_as: string;
};

type AuditData = {
  network?: Record<string, number | string | boolean>;
  brokers?: Record<string, number | string | boolean | BrokerRecord[]>;
  cleanup?: Record<string, number | string | boolean | DuplicatePhone[] | DuplicateName[]>;
  groups?: GroupRecord[];
  capture?: Record<string, number | string | boolean | LatestRecord[]>;
  search_coverage?: Record<string, number | string>;
  learning?: Record<string, number | string | LearnedTerm[]>;
};

type BrokerRecord = {
  name: string;
  phone?: string;
  observations: number;
  listings: number;
  requirements: number;
  groups: number;
};

type DuplicatePhone = {
  phone: string;
  count: number;
};

type DuplicateName = {
  name: string;
  phone_count: number;
  phones?: string;
};

type GroupRecord = {
  name: string;
  jid: string;
  messages: number;
  unique_senders: number;
  listings: number;
  requirements: number;
  markets: number;
  buildings: number;
  signal_ratio: number;
  last_seen: string;
};

type EvidenceGroup = {
  name: string;
  count: number;
};

type SearchEvidence = {
  count: number;
  first_seen: string;
  last_seen: string;
  groups: number;
  unique_senders: number;
  top_groups: EvidenceGroup[];
  recent?: LatestRecord[];
};

function num(value: number | string | null | undefined) {
  const n = Number(value || 0);
  return n.toLocaleString();
}

function timeAgo(ts: string) {
  if (!ts || ts === "never") return "never";
  const ms = new Date(ts).getTime();
  if (Number.isNaN(ms)) return ts;
  const secs = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (secs < 10) return "just now";
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function dateLabel(ts: string) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function clockLabel(ts: string) {
  if (!ts) return "--:--";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "--:--";
  return d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function cleanDisplayText(value: string) {
  return String(value || "")
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
    .replace(/(^|\s)[*_~`#>]+/g, "$1")
    .replace(/[*_~`#>]+(\s|$)/g, "$1")
    .replace(/[*_~`#>]{2,}/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-white/10 bg-zinc-900 ${className}`}>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500">{children}</div>;
}

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <Label>{label}</Label>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-white">{value}</div>
      {sub ? <div className="mt-1 text-[11px] text-zinc-500">{sub}</div> : null}
    </Card>
  );
}

function MiniRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg bg-zinc-800 px-3 py-2 text-xs">
      <span className="truncate text-zinc-400">{label}</span>
      <span className="shrink-0 font-mono font-semibold text-white">{value}</span>
    </div>
  );
}

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h2 className="text-sm font-semibold text-white">{title}</h2>
        {sub ? <div className="mt-1 text-xs text-zinc-500">{sub}</div> : null}
      </div>
    </div>
  );
}

function getNumber(record: Record<string, unknown>, key: string) {
  return Number(record[key] || 0);
}

function getString(record: Record<string, unknown>, key: string) {
  return String(record[key] || "");
}

function RecordRow({ item }: { item: LatestRecord }) {
  return (
    <div className="grid grid-cols-[64px_minmax(0,1fr)_74px] gap-3 border-b border-[rgba(255,255,255,0.05)] px-4 py-3 last:border-b-0">
      <div className="font-mono text-[11px] text-zinc-500">{clockLabel(item.time)}</div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="max-w-[220px] truncate font-semibold text-white">{item.conversation || "WhatsApp"}</span>
          <span className="text-zinc-500">{item.sender || "Unknown"}</span>
        </div>
        <div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-400">{cleanDisplayText(item.preview) || "No text content"}</div>
      </div>
      <div className="self-start rounded-full border border-[#3EE88A]/25 bg-[#3EE88A]/10 px-2 py-1 text-center text-[10px] font-bold uppercase tracking-wide text-[#3EE88A]">
        {item.stored === false ? "Queued" : "Stored"}
      </div>
    </div>
  );
}

export default function AuditPage() {
  const [data, setData] = useState<AuditData | null>(null);
  const [query, setQuery] = useState("");
  const [evidence, setEvidence] = useState<SearchEvidence | null>(null);
  const [loading, setLoading] = useState(true);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState("");
  const [auditGroups, setAuditGroups] = useState<api.AuditGroupCard[]>([]);
  const [excludedJids, setExcludedJids] = useState<string[]>([]);
  const [excludedLoading, setExcludedLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      try {
        setData(await api.getAuditIntelligence());
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 600));
        setData(await api.getAuditIntelligence());
      }
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : "Failed to load audit data");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      void load();
    }, 0);
    return () => clearTimeout(t);
  }, [load]);

  useEffect(() => {
    const term = query.trim();
    if (!term) {
      return;
    }
    const t = setTimeout(async () => {
      setSearching(true);
      try {
        setEvidence(await api.getAuditSearchEvidence(term));
      } catch {
        setEvidence(null);
      } finally {
        setSearching(false);
      }
    }, 250);
    return () => clearTimeout(t);
  }, [query]);

  // Fetch audit groups and excluded JIDs for parser control
  useEffect(() => {
    async function load() {
      try {
        const [groups, excluded] = await Promise.all([
          api.getAuditGroups(),
          api.getExcludedGroups(),
        ]);
        setAuditGroups(groups);
        setExcludedJids(excluded);
      } catch {
        // silent
      }
    }
    load();
  }, []);

  async function toggleGroupParser(jid: string, currentlyExcluded: boolean) {
    setExcludedLoading(true);
    try {
      const updated = currentlyExcluded
        ? excludedJids.filter((j) => j !== jid)
        : [...excludedJids, jid];
      await api.setExcludedGroups(updated);
      setExcludedJids(updated);
    } catch {
      // silent
    } finally {
      setExcludedLoading(false);
    }
  }

  const capture = (data?.capture || {}) as Record<string, unknown>;
  const network = (data?.network || {}) as Record<string, unknown>;
  const brokers = (data?.brokers || {}) as Record<string, unknown>;
  const cleanup = (data?.cleanup || {}) as Record<string, unknown>;
  const coverage = (data?.search_coverage || {}) as Record<string, unknown>;
  const learning = (data?.learning || {}) as Record<string, unknown>;
  const groups = (Array.isArray(data?.groups) ? data.groups : []) as GroupRecord[];
  const latest = (Array.isArray(capture.latest_records) ? capture.latest_records : []) as LatestRecord[];
  const learned = (Array.isArray(learning.recently_learned) ? learning.recently_learned : []) as LearnedTerm[];
  const topBrokers = (Array.isArray(brokers.top) ? brokers.top : []) as BrokerRecord[];
  const duplicatePhones = (Array.isArray(cleanup.duplicate_phones) ? cleanup.duplicate_phones : []) as DuplicatePhone[];
  const duplicateNames = (Array.isArray(cleanup.duplicate_names) ? cleanup.duplicate_names : []) as DuplicateName[];
  const hasLearning = getNumber(learning, "unknown_terms") > 0 || getNumber(learning, "needs_review") > 0 || learned.length > 0;

  const recallValue = getNumber(coverage, "recall_ready");
  const recallReady = `${recallValue % 1 === 0 ? recallValue.toFixed(0) : recallValue.toFixed(1)}%`;

  if (loading && !data) {
    return <div className="py-16 text-center text-sm text-zinc-500">Loading WhatsApp evidence...</div>;
  }

  if (error && !data) {
    return (
      <div className="py-16 text-center">
        <div className="text-sm text-red-400">Failed to load WhatsApp Audit</div>
        <div className="mt-2 text-xs text-zinc-500">{error}</div>
        <button onClick={load} className="mt-4 rounded-lg bg-[#3EE88A] px-3 py-2 text-xs font-semibold text-black">
          Retry
        </button>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Label>WhatsApp Audit</Label>
          <h1 className="mt-2 text-2xl font-bold text-white">Knowledge Capture</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-zinc-400">
            Proof that WhatsApp conversations are being captured, stored, searchable, and ready for recall.
          </p>
        </div>
        <button onClick={load} className="rounded-lg border border-white/10 bg-zinc-800 px-3 py-2 text-xs font-semibold text-zinc-400 hover:text-white">
          Refresh
        </button>
      </div>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Metric
          label="Status"
          value={<span className={capture.status === "connected" ? "text-[#3EE88A]" : "text-[#f59e0b]"}>{capture.status === "connected" ? "Connected" : "Stale"}</span>}
          sub={`Last message ${timeAgo(getString(capture, "last_message") || getString(network, "last_message"))}`}
        />
        <Metric label="Messages Captured" value={num(getNumber(capture, "messages_captured") || getNumber(network, "total_messages"))} />
        <Metric label="Knowledge Records" value={num(getNumber(capture, "knowledge_records") || getNumber(network, "knowledge_records"))} />
        <Metric label="Attachments" value={num(getNumber(capture, "attachments") || getNumber(network, "attachments"))} />
        <Metric label="Communities" value={num(getNumber(capture, "communities") || getNumber(network, "communities"))} />
        <Metric label="Groups" value={num(getNumber(capture, "groups") || getNumber(network, "total_groups"))} sub={`${num(getNumber(network, "active_groups_24h"))} active in 24h`} />
        <Metric label="Broadcasts" value={num(getNumber(capture, "broadcasts") || getNumber(network, "broadcasts"))} />
        <Metric label="Direct Messages" value={num(getNumber(capture, "direct_messages") || getNumber(network, "direct_messages"))} />
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
        <div className="space-y-3">
          <SectionTitle title="Latest Knowledge Records" sub="Recent WhatsApp messages that entered the knowledge store." />
          <Card className="overflow-hidden">
            {latest.length ? latest.slice(0, 8).map((item) => <RecordRow key={item.id} item={item} />) : (
              <div className="p-6 text-sm text-zinc-500">No captured records yet.</div>
            )}
          </Card>
        </div>

        <div className="space-y-3">
          <SectionTitle title="Search Captured Knowledge" sub="Check whether PropAI remembers a building, broker, locality, client, or phrase." />
          <Card className="p-4">
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (!e.target.value.trim()) setEvidence(null);
              }}
              className="w-full rounded-lg border border-white/10 bg-black px-3 py-2 text-sm text-white outline-none placeholder:text-[#475569] focus:border-[#3EE88A]/60"
              placeholder="Search WhatsApp memory..."
            />
            <div className="mt-4 rounded-lg bg-zinc-800 p-4">
              <Label>{searching ? "Searching" : evidence?.count ? "Remembered" : "Result"}</Label>
              <div className="mt-1 text-3xl font-semibold tabular-nums text-white">{num(evidence?.count || 0)} times</div>
              <div className="mt-1 text-xs text-zinc-500">
                Across {num(evidence?.groups || 0)} groups and {num(evidence?.unique_senders || 0)} senders
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3">
              <Metric label="First Seen" value={<span className="text-base">{dateLabel(evidence?.first_seen || "")}</span>} />
              <Metric label="Last Seen" value={<span className="text-base">{evidence?.last_seen ? timeAgo(evidence.last_seen) : "-"}</span>} />
              <Metric label="Groups" value={num(evidence?.groups)} />
              <Metric label="Unique Senders" value={num(evidence?.unique_senders)} />
            </div>
            {evidence?.top_groups?.length ? (
              <div className="mt-4 space-y-2">
                <Label>Top Conversations</Label>
                {evidence.top_groups.map((group) => (
                  <div key={group.name} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-zinc-400">{group.name}</span>
                    <span className="font-mono text-white">{num(group.count)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {evidence?.recent?.length ? (
              <div className="mt-4 space-y-2">
                <Label>Recent Evidence</Label>
                {evidence.recent.slice(0, 3).map((item) => (
                  <div key={item.id} className="rounded-lg bg-black px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-semibold text-white">{item.conversation || "WhatsApp"}</span>
                      <span className="shrink-0 font-mono text-zinc-500">{clockLabel(item.time)}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-zinc-400">{cleanDisplayText(item.preview)}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </Card>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
        <div className="space-y-3">
          <SectionTitle title="Broker Network" sub="People identified from WhatsApp messages, broker profiles, phones, and group activity." />
          <Card className="p-4">
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Total Brokers" value={num(getNumber(brokers, "total"))} sub="Canonical broker profiles" />
              <Metric label="Active This Week" value={num(getNumber(brokers, "recently_active"))} sub="Seen in recent messages" />
              <Metric label="Known Phones" value={num(getNumber(brokers, "unique_phones"))} sub="Unique captured phone numbers" />
              <Metric label="Duplicate Members" value={num(duplicatePhones.length + duplicateNames.length)} sub="Same phone/JID or name conflicts" />
            </div>
            <div className="mt-4 space-y-2">
              <Label>Cleanup Signals</Label>
              <MiniRow label="Phone numbers attached to multiple WhatsApp identities" value={num(duplicatePhones.length)} />
              <MiniRow label="Broker names attached to multiple phone numbers" value={num(duplicateNames.length)} />
              <MiniRow label="Brokers without market coverage" value={num(getNumber(cleanup, "brokers_no_market"))} />
            </div>
          </Card>
        </div>

        <div className="space-y-3">
          <SectionTitle title="Top Broker Activity" sub="Highest-volume broker profiles currently visible in captured conversations." />
          <Card className="overflow-hidden">
            {topBrokers.length ? topBrokers.slice(0, 6).map((broker) => (
              <div key={`${broker.name}-${broker.phone || ""}`} className="grid grid-cols-[minmax(0,1fr)_80px_80px_70px] gap-3 border-b border-[rgba(255,255,255,0.05)] px-4 py-3 text-xs last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-white">{broker.name || broker.phone || "Unknown broker"}</div>
                  <div className="mt-0.5 truncate font-mono text-[10px] text-zinc-500">{broker.phone || "No phone"}</div>
                </div>
                <div>
                  <Label>Posts</Label>
                  <div className="mt-1 font-mono text-white">{num(broker.observations)}</div>
                </div>
                <div>
                  <Label>Listings</Label>
                  <div className="mt-1 font-mono text-white">{num(broker.listings)}</div>
                </div>
                <div>
                  <Label>Groups</Label>
                  <div className="mt-1 font-mono text-white">{num(broker.groups)}</div>
                </div>
              </div>
            )) : (
              <div className="p-6 text-sm text-zinc-500">No broker profiles calculated yet.</div>
            )}
          </Card>
        </div>
      </section>

      {groups.length ? (
        <section className="space-y-3">
          <SectionTitle title="Group Audit" sub="Which WhatsApp groups are producing messages, senders, listings, requirements, markets, and building signals." />
          <Card className="overflow-hidden">
            <div className="grid grid-cols-[minmax(0,1fr)_80px_80px_80px_80px_80px] gap-3 border-b border-white/10 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500">
              <div>Group</div>
              <div>Messages</div>
              <div>Members</div>
              <div>Listings</div>
              <div>Buyers</div>
              <div>Signal</div>
            </div>
            {groups.slice(0, 8).map((group) => (
              <div key={group.jid} className="grid grid-cols-[minmax(0,1fr)_80px_80px_80px_80px_80px] gap-3 border-b border-[rgba(255,255,255,0.05)] px-4 py-3 text-xs last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-white">{group.name}</div>
                  <div className="mt-0.5 truncate text-[10px] text-zinc-500">{timeAgo(group.last_seen)} · {num(group.markets)} markets · {num(group.buildings)} buildings</div>
                </div>
                <div className="font-mono text-white">{num(group.messages)}</div>
                <div className="font-mono text-white">{num(group.unique_senders)}</div>
                <div className="font-mono text-white">{num(group.listings)}</div>
                <div className="font-mono text-white">{num(group.requirements)}</div>
                <div className="font-mono text-[#3EE88A]">{num(group.signal_ratio)}%</div>
              </div>
            ))}
          </Card>
        </section>
      ) : null}

      {auditGroups.length ? (
        <section className="space-y-3">
          <SectionTitle title="Group Parser Control" sub="Toggle parser on/off per group. Opted-out groups are skipped during webhook processing." />
          <Card className="overflow-hidden">
            <div className="grid grid-cols-[minmax(0,1fr)_80px_100px] gap-3 border-b border-white/10 px-4 py-3 text-[10px] font-bold uppercase tracking-[0.12em] text-zinc-500">
              <div>Group</div>
              <div>Messages</div>
              <div>Parser</div>
            </div>
            {auditGroups.map((group) => {
              const isExcluded = excludedJids.includes(group.jid);
              return (
                <div key={group.jid} className="grid grid-cols-[minmax(0,1fr)_80px_100px] gap-3 border-b border-[rgba(255,255,255,0.05)] px-4 py-3 text-xs items-center last:border-b-0">
                  <div className="min-w-0">
                    <div className="truncate font-semibold text-white">{group.name}</div>
                    <div className="mt-0.5 truncate text-[10px] text-zinc-500">{group.jid}</div>
                  </div>
                  <div className="font-mono text-white">{num(group.messages)}</div>
                  <div>
                    <button
                      onClick={() => toggleGroupParser(group.jid, isExcluded)}
                      disabled={excludedLoading}
                      className={`w-full rounded-lg px-2.5 py-1.5 text-[11px] font-semibold transition-colors ${
                        isExcluded
                          ? "bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20"
                          : "bg-emerald-500/10 text-emerald-400 border border-emerald-500/20 hover:bg-emerald-500/20"
                      }`}
                    >
                      {isExcluded ? "Opted Out" : "Parser On"}
                    </button>
                  </div>
                </div>
              );
            })}
          </Card>
        </section>
      ) : null}

      <section className={`grid gap-4 ${hasLearning ? "lg:grid-cols-2" : "lg:grid-cols-1"}`}>
        {hasLearning ? (
        <div className="space-y-3">
          <SectionTitle title="Knowledge Resolution Queue" sub="Only shown when unresolved terms or accepted learning records exist." />
          <Card className="p-4">
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Unknown Terms" value={num(getNumber(learning, "unknown_terms"))} />
              <Metric label="Needs Review" value={num(getNumber(learning, "needs_review"))} />
            </div>
            <div className="mt-4">
              <Label>Recently Learned</Label>
              <div className="mt-2 space-y-2">
                {learned.length ? learned.map((item, i) => (
                  <div key={`${item.term}-${i}`} className="flex items-center justify-between gap-3 rounded-lg bg-zinc-800 px-3 py-2 text-xs">
                    <span className="font-semibold text-white">{item.term}</span>
                    <span className="text-zinc-400">{String(item.learned_as || "").replace(" -> ", " as ")}</span>
                  </div>
                )) : (
                  <div className="rounded-lg bg-zinc-800 px-3 py-3 text-xs text-zinc-500">No recent learning records yet.</div>
                )}
              </div>
            </div>
          </Card>
        </div>
        ) : null}

        <div className="space-y-3">
          <SectionTitle title="Search Coverage" sub="How much WhatsApp memory can be retrieved by keyword search and semantic AI recall." />
          <Card className="p-4">
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Messages" value={num(getNumber(coverage, "messages"))} sub="Raw WhatsApp messages stored" />
              <Metric label="Indexed" value={num(getNumber(coverage, "indexed"))} sub="Rows placed into the text index" />
              <Metric label="Searchable" value={num(getNumber(coverage, "searchable"))} sub="Records available to keyword search" />
              <Metric label="Embeddings" value={num(getNumber(coverage, "embeddings"))} sub="Vector rows used for semantic recall" />
            </div>
            <div className="mt-4 rounded-lg border border-[#3EE88A]/20 bg-[#3EE88A]/10 p-4">
              <Label>Recall Ready</Label>
              <div className="mt-1 text-4xl font-semibold text-[#3EE88A]">{recallReady}</div>
              <div className="mt-1 text-xs leading-5 text-zinc-400">
                Percentage of captured knowledge records that are in the searchable index. Embeddings can be lower because they are only needed for semantic AI recall, not basic keyword lookup.
              </div>
            </div>
          </Card>
        </div>
      </section>

      <div className="pb-4 text-center text-[10px] text-[#475569]">
        Last updated {timeAgo(getString(capture, "last_message") || getString(network, "last_message"))} from {num(getNumber(capture, "messages_captured") || getNumber(network, "total_messages"))} captured messages.
      </div>
    </div>
  );
}
