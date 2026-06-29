"use client";

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
  capture?: Record<string, number | string | boolean | LatestRecord[]>;
  search_coverage?: Record<string, number | string>;
  learning?: Record<string, number | string | LearnedTerm[]>;
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

function Card({ children, className = "" }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={`rounded-lg border border-[rgba(255,255,255,0.06)] bg-[#0d1117] ${className}`}>
      {children}
    </div>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return <div className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#64748b]">{children}</div>;
}

function Metric({ label, value, sub }: { label: string; value: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <Label>{label}</Label>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-[#e2e8f0]">{value}</div>
      {sub ? <div className="mt-1 text-[11px] text-[#64748b]">{sub}</div> : null}
    </Card>
  );
}

function SectionTitle({ title, sub }: { title: string; sub?: string }) {
  return (
    <div className="flex items-end justify-between gap-4">
      <div>
        <h2 className="text-sm font-semibold text-[#e2e8f0]">{title}</h2>
        {sub ? <div className="mt-1 text-xs text-[#64748b]">{sub}</div> : null}
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
      <div className="font-mono text-[11px] text-[#64748b]">{clockLabel(item.time)}</div>
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span className="max-w-[220px] truncate font-semibold text-[#e2e8f0]">{item.conversation || "WhatsApp"}</span>
          <span className="text-[#64748b]">{item.sender || "Unknown"}</span>
        </div>
        <div className="mt-1 line-clamp-2 text-xs leading-5 text-[#94a3b8]">{item.preview || "No text content"}</div>
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

  const capture = (data?.capture || {}) as Record<string, unknown>;
  const network = (data?.network || {}) as Record<string, unknown>;
  const coverage = (data?.search_coverage || {}) as Record<string, unknown>;
  const learning = (data?.learning || {}) as Record<string, unknown>;
  const latest = (Array.isArray(capture.latest_records) ? capture.latest_records : []) as LatestRecord[];
  const learned = (Array.isArray(learning.recently_learned) ? learning.recently_learned : []) as LearnedTerm[];

  const recallValue = getNumber(coverage, "recall_ready");
  const recallReady = `${recallValue % 1 === 0 ? recallValue.toFixed(0) : recallValue.toFixed(1)}%`;

  if (loading && !data) {
    return <div className="py-16 text-center text-sm text-[#64748b]">Loading WhatsApp evidence...</div>;
  }

  if (error && !data) {
    return (
      <div className="py-16 text-center">
        <div className="text-sm text-red-400">Failed to load WhatsApp Audit</div>
        <div className="mt-2 text-xs text-[#64748b]">{error}</div>
        <button onClick={load} className="mt-4 rounded-lg bg-[#3EE88A] px-3 py-2 text-xs font-semibold text-[#04100a]">
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
          <h1 className="mt-2 text-2xl font-bold text-[#e2e8f0]">Knowledge Capture</h1>
          <p className="mt-2 max-w-2xl text-sm leading-6 text-[#94a3b8]">
            Proof that WhatsApp conversations are being captured, stored, searchable, and ready for recall.
          </p>
        </div>
        <button onClick={load} className="rounded-lg border border-[rgba(255,255,255,0.1)] bg-[#111820] px-3 py-2 text-xs font-semibold text-[#94a3b8] hover:text-white">
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
              <div className="p-6 text-sm text-[#64748b]">No captured records yet.</div>
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
              className="w-full rounded-lg border border-[rgba(255,255,255,0.08)] bg-[#090d12] px-3 py-2 text-sm text-white outline-none placeholder:text-[#475569] focus:border-[#3EE88A]/60"
              placeholder="Search WhatsApp memory..."
            />
            <div className="mt-4 rounded-lg bg-[#111820] p-4">
              <Label>{searching ? "Searching" : evidence?.count ? "Remembered" : "Result"}</Label>
              <div className="mt-1 text-3xl font-semibold tabular-nums text-[#e2e8f0]">{num(evidence?.count || 0)} times</div>
              <div className="mt-1 text-xs text-[#64748b]">
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
                    <span className="truncate text-[#94a3b8]">{group.name}</span>
                    <span className="font-mono text-[#e2e8f0]">{num(group.count)}</span>
                  </div>
                ))}
              </div>
            ) : null}
            {evidence?.recent?.length ? (
              <div className="mt-4 space-y-2">
                <Label>Recent Evidence</Label>
                {evidence.recent.slice(0, 3).map((item) => (
                  <div key={item.id} className="rounded-lg bg-[#090d12] px-3 py-2 text-xs">
                    <div className="flex items-center justify-between gap-3">
                      <span className="truncate font-semibold text-[#e2e8f0]">{item.conversation || "WhatsApp"}</span>
                      <span className="shrink-0 font-mono text-[#64748b]">{clockLabel(item.time)}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-[#94a3b8]">{item.preview}</div>
                  </div>
                ))}
              </div>
            ) : null}
          </Card>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-3">
          <SectionTitle title="Knowledge Learning" sub="Terms PropAI has not fully resolved yet, plus recent accepted learning." />
          <Card className="p-4">
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Unknown Terms" value={num(getNumber(learning, "unknown_terms"))} />
              <Metric label="Needs Review" value={num(getNumber(learning, "needs_review"))} />
            </div>
            <div className="mt-4">
              <Label>Recently Learned</Label>
              <div className="mt-2 space-y-2">
                {learned.length ? learned.map((item, i) => (
                  <div key={`${item.term}-${i}`} className="flex items-center justify-between gap-3 rounded-lg bg-[#111820] px-3 py-2 text-xs">
                    <span className="font-semibold text-[#e2e8f0]">{item.term}</span>
                    <span className="text-[#94a3b8]">{String(item.learned_as || "").replace(" -> ", " as ")}</span>
                  </div>
                )) : (
                  <div className="rounded-lg bg-[#111820] px-3 py-3 text-xs text-[#64748b]">No recent learning records yet.</div>
                )}
              </div>
            </div>
          </Card>
        </div>

        <div className="space-y-3">
          <SectionTitle title="Search Coverage" sub="Whether captured knowledge is available for retrieval." />
          <Card className="p-4">
            <div className="grid grid-cols-2 gap-3">
              <Metric label="Messages" value={num(getNumber(coverage, "messages"))} />
              <Metric label="Indexed" value={num(getNumber(coverage, "indexed"))} />
              <Metric label="Searchable" value={num(getNumber(coverage, "searchable"))} />
              <Metric label="Embeddings" value={num(getNumber(coverage, "embeddings"))} />
            </div>
            <div className="mt-4 rounded-lg border border-[#3EE88A]/20 bg-[#3EE88A]/10 p-4">
              <Label>Recall Ready</Label>
              <div className="mt-1 text-4xl font-semibold text-[#3EE88A]">{recallReady}</div>
              <div className="mt-1 text-xs text-[#94a3b8]">Captured records available to search and recall.</div>
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
