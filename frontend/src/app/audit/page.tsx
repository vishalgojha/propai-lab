"use client";

export const dynamic = "force-dynamic";

import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import Link from "next/link";
import { AlertTriangle, Eye, Network, RefreshCw, ShieldCheck, Users } from "lucide-react";
import * as api from "@/lib/api";
import { classifyFormatIssue } from "@/lib/format-issues";

type LoadState = {
  raw: api.RawMessage[];
  threads: api.InboxThread[];
  groups: api.AuditGroupCard[];
  health: api.AuditCaptureHealth | null;
  excluded: string[];
  errors: string[];
};

type GroupInsight = {
  key: string;
  name: string;
  messages: number;
  latest: string;
  uniqueMembers: number;
  duplicateMembers: number;
  overlapPct: number;
  listings: number;
  requirements: number;
  rentSignals: number;
  saleSignals: number;
  formatIssues: number;
  duplicatePct: number;
  activeBrokers: number;
  parserOff: boolean;
};

const emptyState: LoadState = {
  raw: [],
  threads: [],
  groups: [],
  health: null,
  excluded: [],
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

function digits(value?: string) {
  return (value || "").replace(/\D/g, "");
}

function memberKey(message: api.RawMessage) {
  const phone = digits(message.sender_phone || message.broker_phone).slice(-10);
  if (phone.length === 10) return `phone:${phone}`;
  return message.sender_jid || message.sender || message.broker_name || "unknown";
}

function groupKey(message: api.RawMessage) {
  return message.chat_id || message.conversation_key || message.chat_name || message.conversation_name || message.group_name || "Unknown group";
}

function groupName(message: api.RawMessage) {
  return message.chat_name || message.conversation_name || message.group_name || "Unknown group";
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

function pct(value?: number | string | null) {
  const n = Number(value || 0);
  return `${Math.round(n)}%`;
}

function hasRentSignal(text: string) {
  return /\b(on rent|for rent|rent only|rental|lease|leave\s*&\s*license|l\s*&\s*l|per month|p\.?m\.?)\b/i.test(text);
}

function hasSaleSignal(text: string) {
  return /\b(for sale|on sale|distress sale|outright|sale price|reserve price|asking)\b/i.test(text);
}

function isRequirement(text: string) {
  return /\b(requirement|required|wanted|looking|need|buyer|tenant)\b/i.test(text);
}

function isListing(text: string) {
  return /\b(available|on rent|for rent|for sale|on sale|distress|outright|inspection|call|contact)\b/i.test(text);
}

function cleanPreview(value?: string) {
  return String(value || "")
    .replace(/[\p{Extended_Pictographic}\uFE0F]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
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
  const [savingJid, setSavingJid] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    const [raw, threads, groups, health, excluded] = await Promise.all([
      safe("raw messages", () => api.getRaw(1000, 0), [] as api.RawMessage[]),
      safe("market inbox", () => api.getInboxThreads(500, 0), [] as api.InboxThread[]),
      safe("group audit", () => api.getAuditGroups(), [] as api.AuditGroupCard[]),
      safe("capture health", () => api.getAuditCaptureHealth(), null as api.AuditCaptureHealth | null),
      safe("group controls", () => api.getExcludedGroups(), [] as string[]),
    ]);

    setState({
      raw: raw.value,
      threads: threads.value,
      groups: groups.value,
      health: health.value,
      excluded: excluded.value,
      errors: [raw.error, threads.error, groups.error, health.error, excluded.error].filter(Boolean) as string[],
    });
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const insights = useMemo<GroupInsight[]>(() => {
    const membersByGroup = new Map<string, Set<string>>();
    const memberGroups = new Map<string, Set<string>>();
    const rawByGroup = new Map<string, api.RawMessage[]>();

    for (const message of state.raw) {
      const gKey = groupKey(message);
      const mKey = memberKey(message);
      if (!membersByGroup.has(gKey)) membersByGroup.set(gKey, new Set());
      if (!memberGroups.has(mKey)) memberGroups.set(mKey, new Set());
      if (!rawByGroup.has(gKey)) rawByGroup.set(gKey, []);
      membersByGroup.get(gKey)?.add(mKey);
      memberGroups.get(mKey)?.add(gKey);
      rawByGroup.get(gKey)?.push(message);
    }

    const groupCards = new Map<string, api.AuditGroupCard>();
    for (const group of state.groups) {
      groupCards.set(group.jid || group.name, group);
    }

    const keys = new Set<string>([...rawByGroup.keys(), ...groupCards.keys()]);
    return [...keys].map((key) => {
      const group = groupCards.get(key);
      const messages = rawByGroup.get(key) || [];
      const members = membersByGroup.get(key) || new Set<string>();
      let duplicateMembers = 0;
      for (const member of members) {
        if ((memberGroups.get(member)?.size || 0) > 1) duplicateMembers += 1;
      }
      const latest = messages
        .map((message) => message.timestamp || message.created_at || message.latest_message_at || "")
        .filter(Boolean)
        .sort()
        .at(-1) || group?.last_activity || "";
      const issueCount = messages.reduce((total, message) => total + (classifyFormatIssue(message) ? 1 : 0), 0);
      const text = messages.map((message) => message.message || "").join("\n");
      const listingCount = messages.reduce((total, message) => total + (isListing(message.message || "") ? 1 : 0), 0);
      const requirementCount = messages.reduce((total, message) => total + (isRequirement(message.message || "") ? 1 : 0), 0);
      return {
        key,
        name: group?.name || messages[0] ? group?.name || groupName(messages[0]) : key,
        messages: group?.messages || messages.length,
        latest,
        uniqueMembers: members.size,
        duplicateMembers,
        overlapPct: members.size ? Math.round((duplicateMembers / members.size) * 100) : 0,
        listings: group?.listings || listingCount,
        requirements: group?.requirements || requirementCount,
        rentSignals: (text.match(/\b(rent|rental|lease|leave\s*&\s*license|l\s*&\s*l)\b/gi) || []).length,
        saleSignals: (text.match(/\b(sale|outright|distress|asking|reserve price)\b/gi) || []).length,
        formatIssues: issueCount,
        duplicatePct: Number(group?.duplicate_pct || 0),
        activeBrokers: group?.active_brokers || members.size,
        parserOff: state.excluded.includes(group?.jid || key),
      };
    }).sort((a, b) => Number(new Date(b.latest || 0)) - Number(new Date(a.latest || 0)));
  }, [state]);

  const network = useMemo(() => {
    const memberGroups = new Map<string, Set<string>>();
    for (const message of state.raw) {
      const member = memberKey(message);
      if (!memberGroups.has(member)) memberGroups.set(member, new Set());
      memberGroups.get(member)?.add(groupKey(message));
    }
    const uniqueMembers = memberGroups.size;
    const duplicateMembers = [...memberGroups.values()].filter((groups) => groups.size > 1).length;
    const appearances = [...memberGroups.values()].reduce((sum, groups) => sum + groups.size, 0);
    return {
      uniqueMembers,
      duplicateMembers,
      appearances,
      overlapPct: uniqueMembers ? Math.round((duplicateMembers / uniqueMembers) * 100) : 0,
      groups: new Set(state.raw.map(groupKey)).size || state.groups.length,
    };
  }, [state.raw, state.groups.length]);

  async function toggleGroup(jid: string, parserOff: boolean) {
    if (!jid) return;
    setSavingJid(jid);
    const next = parserOff ? state.excluded.filter((item) => item !== jid) : [...state.excluded, jid];
    try {
      await api.setExcludedGroups(next);
      setState((current) => ({ ...current, excluded: next }));
    } finally {
      setSavingJid("");
    }
  }

  return (
    <div className="mx-auto max-w-7xl space-y-6 px-6 py-6 text-white">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <div className="text-[10px] font-bold uppercase tracking-[0.18em] text-zinc-500">WhatsApp Audit</div>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">Group Intelligence</h1>
          <p className="mt-2 max-w-3xl text-sm leading-6 text-zinc-400">
            A clean operational view of what your WhatsApp groups are producing: useful opportunities, repeated network members, noisy posts, and parser controls.
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
            Some old audit endpoints are unhealthy, but this page is still usable.
          </div>
          <div className="mt-2 space-y-1 text-xs text-amber-100/75">
            {state.errors.slice(0, 3).map((error) => <div key={error}>{error}</div>)}
          </div>
        </Card>
      )}

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric label="Capture Status" value={state.health?.last_webhook ? "Live" : state.raw.length ? "Recent Data" : "No Data"} sub={`Last webhook ${timeAgo(state.health?.last_webhook)}`} />
        <Metric label="Messages Sampled" value={num(state.raw.length)} sub={`${num(state.threads.length)} market inbox threads loaded`} />
        <Metric label="Groups Seen" value={num(network.groups)} sub={`${num(state.excluded.length)} parser opt-outs`} />
        <Metric label="Parser Queue" value={num(state.health?.queue_backlog)} sub={`${num(state.health?.total_parsed_today)} parsed today`} />
      </section>

      <section className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <Metric label="Unique Members" value={num(network.uniqueMembers)} sub="Unique senders in loaded group data" />
        <Metric label="Duplicate Members" value={num(network.duplicateMembers)} sub="Members appearing in more than one group" />
        <Metric label="Member Appearances" value={num(network.appearances)} sub="Group-member relationships" />
        <Metric label="Network Overlap" value={pct(network.overlapPct)} sub="How repeated your group network is" />
      </section>

      <section className="grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <div className="space-y-3">
          <SectionTitle
            icon={<Eye className="h-4 w-4" strokeWidth={1.8} />}
            title="Group Audit"
            sub="The eye-opener: which groups create useful market signal, which are duplicate-heavy, and which should stay private or parser-off."
          />
          <Card className="overflow-hidden">
            <div className="grid grid-cols-[minmax(220px,1.4fr)_90px_90px_90px_90px_92px_88px] gap-3 border-b border-white/10 px-4 py-2 text-[10px] font-bold uppercase tracking-wide text-zinc-500">
              <div>Group</div>
              <div>Signal</div>
              <div>Members</div>
              <div>Overlap</div>
              <div>Noise</div>
              <div>Freshness</div>
              <div>Parser</div>
            </div>
            {insights.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-zinc-500">
                No group data loaded yet. Once WhatsApp sync captures group messages, this page will populate without depending on the old audit endpoint.
              </div>
            ) : insights.slice(0, 60).map((group) => (
              <div key={group.key} className="grid grid-cols-[minmax(220px,1.4fr)_90px_90px_90px_90px_92px_88px] gap-3 border-b border-white/[0.06] px-4 py-3 text-xs last:border-b-0">
                <div className="min-w-0">
                  <div className="truncate font-semibold text-white">{group.name}</div>
                  <div className="mt-1 line-clamp-1 text-[11px] text-zinc-500">
                    {num(group.messages)} posts · {num(group.activeBrokers)} active members · {group.rentSignals} rent signals · {group.saleSignals} sale signals
                  </div>
                </div>
                <div>
                  <div className="font-mono font-semibold text-[#3EE88A]">{num(group.listings)}</div>
                  <div className="text-[10px] text-zinc-500">{num(group.requirements)} reqs</div>
                </div>
                <div>
                  <div className="font-mono font-semibold text-white">{num(group.uniqueMembers)}</div>
                  <div className="text-[10px] text-zinc-500">{num(group.duplicateMembers)} repeat</div>
                </div>
                <div className={group.overlapPct >= 70 ? "font-mono font-semibold text-amber-300" : "font-mono font-semibold text-zinc-200"}>
                  {pct(group.overlapPct)}
                </div>
                <div>
                  <div className={group.formatIssues > 0 ? "font-mono font-semibold text-amber-300" : "font-mono font-semibold text-zinc-200"}>{num(group.formatIssues)}</div>
                  <div className="text-[10px] text-zinc-500">bad format</div>
                </div>
                <div className="text-zinc-400">{timeAgo(group.latest)}</div>
                <button
                  type="button"
                  disabled={savingJid === group.key}
                  onClick={() => toggleGroup(group.key, group.parserOff)}
                  className={`rounded-md px-2 py-1 text-[10px] font-bold uppercase tracking-wide ${
                    group.parserOff
                      ? "border border-amber-500/30 bg-amber-500/10 text-amber-200"
                      : "border border-[#3EE88A]/25 bg-[#3EE88A]/10 text-[#3EE88A]"
                  }`}
                >
                  {group.parserOff ? "Off" : "On"}
                </button>
              </div>
            ))}
          </Card>
        </div>

        <div className="space-y-3">
          <SectionTitle
            icon={<Network className="h-4 w-4" strokeWidth={1.8} />}
            title="Network Overlap"
            sub="Helps a broker see whether 100 groups are actually 100 networks or the same people reposting everywhere."
          />
          <Card className="p-4">
            <div className="space-y-3">
              {[...insights]
                .sort((a, b) => b.overlapPct - a.overlapPct || b.uniqueMembers - a.uniqueMembers)
                .slice(0, 8)
                .map((group) => (
                  <div key={group.key} className="rounded-md bg-black/30 px-3 py-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="truncate text-sm font-semibold text-white">{group.name}</div>
                      <div className="font-mono text-xs text-amber-300">{pct(group.overlapPct)}</div>
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-500">
                      {num(group.duplicateMembers)} of {num(group.uniqueMembers)} members already appear in another loaded group.
                    </div>
                  </div>
                ))}
              {insights.length === 0 && <div className="text-sm text-zinc-500">No overlap data yet.</div>}
            </div>
          </Card>

          <SectionTitle
            icon={<Users className="h-4 w-4" strokeWidth={1.8} />}
            title="Latest Captured Posts"
            sub="A quick sanity check that WhatsApp sync is still feeding the system."
          />
          <Card className="overflow-hidden">
            {state.raw.slice(0, 8).map((message) => (
              <div key={message.id} className="border-b border-white/[0.06] px-4 py-3 last:border-b-0">
                <div className="flex items-center justify-between gap-3">
                  <div className="truncate text-xs font-semibold text-white">{groupName(message)}</div>
                  <div className="shrink-0 font-mono text-[10px] text-zinc-500">{timeAgo(message.timestamp || message.created_at)}</div>
                </div>
                <div className="mt-1 line-clamp-2 text-xs leading-5 text-zinc-400">{cleanPreview(message.message) || "No text content"}</div>
              </div>
            ))}
            {state.raw.length === 0 && <div className="p-6 text-sm text-zinc-500">No latest posts loaded.</div>}
          </Card>
        </div>
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="p-4">
          <SectionTitle icon={<ShieldCheck className="h-4 w-4" strokeWidth={1.8} />} title="Parser Controls" />
          <p className="mt-3 text-xs leading-5 text-zinc-500">
            Parser-on means PropAI can extract real estate opportunities from the group. Parser-off keeps the group visible for audit but stops market extraction.
          </p>
          <Link href="/settings/privacy" className="mt-4 inline-flex text-xs font-bold text-[#3EE88A] hover:text-white">
            Open privacy settings
          </Link>
        </Card>
        <Card className="p-4">
          <SectionTitle title="Format Pressure" />
          <p className="mt-3 text-xs leading-5 text-zinc-500">
            Bad-format posts are intentionally separated from clean opportunities. This keeps Market Inbox useful and nudges brokers to post cleaner listings.
          </p>
          <Link href="/format-issues" className="mt-4 inline-flex text-xs font-bold text-[#3EE88A] hover:text-white">
            Open format issues
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
