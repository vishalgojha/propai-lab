"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import * as api from "@/lib/api";
import NotesPanel from "@/components/notes/NotesPanel";
import { displayGroupName } from "@/lib/whatsapp-display";

type BrokerStat = {
  observation_count: number;
  listing_count: number;
  requirement_count: number;
  last_seen_at?: string;
};

type BrokerMarket = BrokerStat & { micro_market: string };
type BrokerBuilding = BrokerStat & { building_name: string };
type BrokerGroup = BrokerStat & { group_name: string };
type BrokerObservation = {
  parsed_id: number;
  intent?: string;
  role?: string;
  message_type?: string;
  bhk?: string;
  price?: number;
  price_unit?: string;
  furnishing?: string;
  building_name?: string;
  micro_market?: string;
  confidence?: number;
  created_at?: string;
  seen_at?: string;
  group_name?: string;
};
type BrokerTimelinePoint = { day: string; count: number };
type BrokerContribution = {
  building_name: string;
  broker_obs: number;
  total_obs: number;
  share_pct: number;
  is_exclusive: boolean;
};

type BrokerProfile = {
  id: number;
  name: string;
  phone?: string;
  observation_count: number;
  listing_count: number;
  requirement_count: number;
  rental_count: number;
  commercial_count: number;
  group_count: number;
  market_count: number;
  first_seen_at?: string;
  last_seen_at?: string;
  aliases?: { alias: string; observation_count: number }[];
  phones?: { phone: string; observation_count: number }[];
  markets?: BrokerMarket[];
  buildings?: BrokerBuilding[];
  groups?: BrokerGroup[];
  observations?: BrokerObservation[];
  timeline?: BrokerTimelinePoint[];
  contribution_highlights?: BrokerContribution[];
};

function digits(value?: string) {
  return (value || "").replace(/\D/g, "");
}

function validPhone(phone?: string) {
  return digits(phone).slice(-10).length === 10;
}

function displayPhone(phone?: string) {
  const local = digits(phone).slice(-10);
  if (local.length !== 10) return "";
  return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
}

function displayCompactPhone(phone?: string) {
  const local = digits(phone).slice(-10);
  if (local.length !== 10) return "";
  return `+91 ${local}`;
}

function waLink(phone?: string) {
  const local = digits(phone).slice(-10);
  if (local.length !== 10) return "";
  return `https://wa.me/91${local}`;
}

function isMaskedName(name?: string) {
  return /^\+\d/.test(name || "") || /X{3,}/i.test(name || "");
}

function sourceName(broker: BrokerProfile) {
  if (broker.name && !isMaskedName(broker.name)) return broker.name;
  if (validPhone(broker.phone)) return displayPhone(broker.phone);
  return "Unknown WhatsApp source";
}

function sourceSubtitle(broker: BrokerProfile) {
  if (broker.name && isMaskedName(broker.name)) return "Masked WhatsApp display identity";
  if (validPhone(broker.phone)) return displayPhone(broker.phone);
  return "No usable phone captured yet";
}

function dateLabel(ts?: string) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function shortDate(ts?: string) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function formatPrice(value?: number, unit?: string) {
  if (!value) return "";
  if (value >= 10000000) return `${(value / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  if (value >= 100000) return `${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Lakh`;
  if (unit) return `${value.toLocaleString("en-IN")} ${unit}`;
  return value.toLocaleString("en-IN");
}

function evidenceSummary(item: BrokerObservation) {
  const parts = [item.bhk, item.building_name, item.micro_market].filter(Boolean);
  if (parts.length > 0) return parts.join(" · ");
  if (item.intent) {
    return `${item.intent}${item.message_type ? ` • ${item.message_type}` : ""}`;
  }
  return "Observation";
}

function mixLabel(broker: BrokerProfile) {
  const supply = broker.listing_count || 0;
  const demand = broker.requirement_count || 0;
  if (supply === 0 && demand === 0) return "Unclassified source";
  if (supply >= demand * 3) return "Mostly supply";
  if (demand >= supply * 2) return "Mostly demand";
  return "Balanced supply and demand";
}

function activityLabel(broker: BrokerProfile) {
  const days = broker.timeline?.reduce((sum, point) => sum + point.count, 0) || 0;
  if (!days) return "No activity captured in the last 60 days";
  return `${days} observations captured in the last 60 days`;
}

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-zinc-900 rounded-lg px-3 py-3">
      <div className="text-xl font-bold text-white">{value}</div>
      <div className="text-[10px] text-zinc-500 uppercase tracking-wide mt-0.5">{label}</div>
      {sub ? <div className="text-[10px] text-[#475569] mt-1">{sub}</div> : null}
    </div>
  );
}

function SourceBar({ listing, requirement }: { listing: number; requirement: number }) {
  const total = Math.max(1, listing + requirement);
  const listingPct = Math.round((listing / total) * 100);
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-zinc-800">
        <div className="bg-blue-500" style={{ width: `${listingPct}%` }} />
        <div className="bg-amber-500" style={{ width: `${100 - listingPct}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-zinc-500">
        <span>{listing} supply</span>
        <span>{requirement} demand</span>
      </div>
    </div>
  );
}

export default function BrokerProfilePage() {
  const params = useParams<{ id: string }>();
  const [broker, setBroker] = useState<BrokerProfile | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!params.id) return;
    let cancelled = false;
    async function load() {
      try {
        const rawId = String(params.id);
        // Legacy links used a broker phone as the /brokers/[id] slug. Resolve
        // those links once, then keep the phone out of the canonical URL.
        if (digits(rawId).length >= 10) {
          const resolved = await api.findBroker("", rawId);
          if (!cancelled) window.history.replaceState(null, "", `/brokers/${resolved.broker_id}`);
          if (!cancelled) setBroker(await api.getBroker(resolved.broker_id));
          return;
        }
        const data = await api.getBroker(Number(rawId));
        if (!cancelled) setBroker(data);
      } catch {
        if (!cancelled) setLoadError(true);
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [params.id]);

  async function copyPhone() {
    if (!broker?.phone) return;
    await navigator.clipboard.writeText(displayPhone(broker.phone) || broker.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loadError) return <div className="text-zinc-500 mt-8">Broker profile could not be loaded. <Link href="/brokers" className="text-emerald-400">Back to brokers</Link></div>;
  if (!broker) return <div className="text-zinc-500 mt-8">Loading broker profile…</div>;

  const whatsapp = waLink(broker.phone);
  const parsedPhones = (broker.phones || [])
    .filter((item) => validPhone(item.phone))
    .filter((item, index, all) => all.findIndex((other) => digits(other.phone).slice(-10) === digits(item.phone).slice(-10)) === index);
  const hasRealIdentity = validPhone(broker.phone) || parsedPhones.length > 0;
  const hasUsefulEvidence =
    hasRealIdentity ||
    Boolean(broker.markets?.length) ||
    Boolean(broker.buildings?.length) ||
    Boolean(broker.groups?.length) ||
    Boolean(broker.observations?.length);
  const topMarket = broker.markets?.[0];
  const activity = broker.timeline || [];
  const activityMax = Math.max(1, ...activity.map((point) => point.count));

  return (
    <div className="max-w-6xl space-y-7">
      {!hasUsefulEvidence && (
        <section className="rounded-lg border border-amber-500/20 bg-amber-500/10 px-4 py-3">
          <div className="text-sm font-bold text-amber-100">This broker profile is not ready yet.</div>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-amber-100/75">
            PropAI has not captured a real phone, team member, market, building, or recent parsed opportunity for this source.
            Until that evidence exists, this page should not be treated as a useful broker profile.
          </p>
          <Link href="/inbox" className="mt-2 inline-flex text-xs font-bold text-[#3EE88A] hover:text-white">
            Open Market Inbox evidence
          </Link>
        </section>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/brokers" className="text-xs text-zinc-500 hover:text-white">Back to Broker Sources</Link>
          <h2 className="text-2xl font-bold mt-2">{sourceName(broker)}</h2>
          <div className="text-sm text-zinc-500 mt-1">
            {sourceSubtitle(broker)} · first seen {dateLabel(broker.first_seen_at)} · last active {dateLabel(broker.last_seen_at)}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {validPhone(broker.phone) ? (
            <>
              <button onClick={copyPhone} className="text-xs px-3 py-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white">
                {copied ? "Copied" : "Copy phone"}
              </button>
              {whatsapp && (
                <a href={whatsapp} target="_blank" rel="noreferrer" className="text-xs px-3 py-2 rounded-lg bg-[#3EE88A] text-black font-bold hover:bg-[#2DC96E]">
                  WhatsApp
                </a>
              )}
            </>
          ) : (
            <span className="text-xs px-3 py-2 rounded-lg bg-zinc-800 text-zinc-500">No WhatsApp CTA until a real phone is captured</span>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
        <StatCard label="Messages" value={broker.observation_count} sub="parsed observations" />
        <StatCard label="Supply" value={broker.listing_count} sub="extracted listings" />
        <StatCard label="Demand" value={broker.requirement_count} sub="extracted requirements" />
        <StatCard label="Markets" value={broker.market_count} sub="operating areas" />
        <StatCard label="Groups" value={broker.group_count} sub="source groups" />
      </div>

      <section className="rounded-2xl border border-[#b8d5c0] bg-[#e8f1e9] p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-base font-semibold text-[#123326]">What this source tells us</h3>
            <p className="mt-1 text-xs text-[#4f6d5d]">A compact read of this source’s captured evidence—not a market-wide ranking.</p>
          </div>
          <span className="rounded-full border border-[#9cc6aa] bg-white/60 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.14em] text-[#276342]">Evidence view</span>
        </div>
        <div className="mt-5 grid gap-3 md:grid-cols-3">
          <div className="rounded-xl border border-[#cfdfd2] bg-white/65 p-3">
            <div className="text-[10px] uppercase tracking-[0.14em] text-[#668074]">Source posture</div>
            <div className="mt-1 text-sm font-semibold text-[#173d2a]">{mixLabel(broker)}</div>
            <div className="mt-1 text-xs text-[#587466]">{broker.listing_count} supply · {broker.requirement_count} demand</div>
          </div>
          <div className="rounded-xl border border-[#cfdfd2] bg-white/65 p-3">
            <div className="text-[10px] uppercase tracking-[0.14em] text-[#668074]">Strongest observed market</div>
            <div className="mt-1 text-sm font-semibold text-[#173d2a]">{topMarket?.micro_market || "Not extracted yet"}</div>
            <div className="mt-1 text-xs text-[#587466]">{topMarket ? `${topMarket.observation_count} captured posts` : "No canonical locality evidence"}</div>
          </div>
          <div className="rounded-xl border border-[#cfdfd2] bg-white/65 p-3">
            <div className="text-[10px] uppercase tracking-[0.14em] text-[#668074]">Latest signal</div>
            <div className="mt-1 text-sm font-semibold text-[#173d2a]">{dateLabel(broker.last_seen_at)}</div>
            <div className="mt-1 text-xs text-[#587466]">{activityLabel(broker)}</div>
          </div>
        </div>
      </section>

      <div className="grid gap-5 lg:grid-cols-[1.25fr_0.75fr]">
        <section className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-white">Activity pulse</h3>
              <p className="mt-1 text-xs text-zinc-500">Daily observations over the last 60 days</p>
            </div>
            <span className="text-xs font-medium text-zinc-600">{activityLabel(broker)}</span>
          </div>
          {activity.length ? (
            <div className="mt-5 flex h-28 items-end gap-1" aria-label="Broker activity over the last 60 days">
              {activity.map((point) => (
                <div key={point.day} className="group relative flex h-full flex-1 items-end" title={`${point.day}: ${point.count} observations`}>
                  <div className="w-full rounded-t bg-emerald-400/70 transition-colors group-hover:bg-emerald-300" style={{ height: `${Math.max(8, (point.count / activityMax) * 100)}%` }} />
                </div>
              ))}
            </div>
          ) : (
            <div className="mt-5 rounded-xl border border-dashed border-zinc-300 bg-white/50 px-4 py-5 text-center">
              <div className="text-sm font-semibold text-zinc-700">No dated activity in the last 60 days</div>
              <div className="mt-1 text-xs text-zinc-500">The source still has {broker.observation_count || 0} captured observations overall.</div>
            </div>
          )}
          {activity.length > 0 && (
            <div className="mt-2 flex justify-between text-[10px] text-zinc-600"><span>{shortDate(activity[0].day)}</span><span>{shortDate(activity[activity.length - 1].day)}</span></div>
          )}
        </section>

        <section className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
          <h3 className="text-sm font-semibold text-white">Coverage snapshot</h3>
          <p className="mt-1 text-xs text-zinc-500">Where this source appears in captured evidence</p>
          <div className="mt-4 space-y-3 text-xs">
            <div className="flex items-center justify-between border-b border-white/5 pb-3"><span className="text-zinc-400">Markets</span><span className="font-semibold text-white">{broker.market_count}</span></div>
            <div className="flex items-center justify-between border-b border-white/5 pb-3"><span className="text-zinc-400">Buildings</span><span className="font-semibold text-white">{broker.buildings?.length || 0}</span></div>
            <div className="flex items-center justify-between border-b border-white/5 pb-3"><span className="text-zinc-400">Source groups</span><span className="font-semibold text-white">{broker.group_count}</span></div>
            <div className="flex items-center justify-between"><span className="text-zinc-400">Commercial posts</span><span className="font-semibold text-white">{broker.commercial_count}</span></div>
          </div>
        </section>
      </div>

      {parsedPhones.length > 0 && (
        <section className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
          <h3 className="text-sm font-semibold text-white">Parsed Contact Numbers</h3>
          <div className="mt-1 text-xs leading-relaxed text-zinc-500">
            These are real numbers PropAI has seen attached to this broker source. Team/agency grouping is shown only when the data gives stronger relationship evidence.
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {parsedPhones.slice(0, 12).map((item) => {
              const link = waLink(item.phone);
              return (
                <div key={digits(item.phone).slice(-10)} className="rounded-md border border-white/10 bg-black/30 px-3 py-2">
                  <div className="text-sm font-semibold text-white">{displayCompactPhone(item.phone)}</div>
                  <div className="mt-0.5 text-[10px] uppercase tracking-wide text-zinc-500">{item.observation_count} mentions</div>
                  {link && (
                    <a href={link} target="_blank" rel="noreferrer" className="mt-2 inline-flex text-xs font-bold text-[#3EE88A] hover:text-white">
                      Contact on WhatsApp
                    </a>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      )}

      <section className="bg-zinc-900 rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Source Mix</h3>
            <div className="text-xs text-zinc-500 mt-0.5">{mixLabel(broker)}</div>
          </div>
          <div className="flex gap-2 text-[10px] text-zinc-500">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-500" /> Supply</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> Demand</span>
          </div>
        </div>
        <SourceBar listing={broker.listing_count} requirement={broker.requirement_count} />
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section>
          <h3 className="text-sm font-semibold mb-2 text-zinc-500 uppercase tracking-wide">Operating Areas</h3>
          <div className="space-y-2">
            {(broker.markets || []).slice(0, 12).map((market) => (
              <div key={market.micro_market} className="bg-zinc-900 rounded px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-white">{market.micro_market}</div>
                  <div className="text-[10px] text-zinc-500">{market.observation_count} posts</div>
                </div>
                <SourceBar listing={market.listing_count} requirement={market.requirement_count} />
              </div>
            ))}
            {!broker.markets?.length && <div className="text-sm text-zinc-500">No market extracted yet.</div>}
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold mb-2 text-zinc-500 uppercase tracking-wide">Groups Seen In</h3>
          <div className="space-y-2">
            {(broker.groups || []).slice(0, 12).map((group) => (
              <div key={group.group_name} className="bg-zinc-900 rounded px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-white truncate">{displayGroupName(group.group_name)}</div>
                  <div className="text-[10px] text-zinc-500 whitespace-nowrap">{shortDate(group.last_seen_at)}</div>
                </div>
                <div className="text-[10px] text-zinc-500 mt-1">
                  {group.observation_count} posts · {group.listing_count} supply · {group.requirement_count} demand
                </div>
              </div>
            ))}
            {!broker.groups?.length && <div className="text-sm text-zinc-500">No groups extracted yet.</div>}
          </div>
        </section>
      </div>

      {!!broker.buildings?.length && (
        <section>
          <h3 className="text-sm font-semibold mb-2 text-zinc-500 uppercase tracking-wide">Buildings Mentioned</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {broker.buildings.slice(0, 18).map((building) => (
              <div key={building.building_name} className="bg-zinc-900 rounded px-2.5 py-2">
                <div className="text-sm font-medium">{building.building_name}</div>
                <div className="text-[10px] text-zinc-500">
                  {building.listing_count} supply · {building.requirement_count} demand · {building.observation_count} posts
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!!broker.contribution_highlights?.length && (
        <section className="rounded-2xl border border-white/10 bg-zinc-900 p-5">
          <div>
            <h3 className="text-sm font-semibold text-white">Building concentration signals</h3>
            <p className="mt-1 text-xs text-zinc-500">Buildings where this broker accounts for a large share of captured broker observations.</p>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {broker.contribution_highlights.slice(0, 6).map((item) => (
              <div key={item.building_name} className="flex items-center justify-between gap-3 rounded-xl border border-white/5 bg-black/15 px-3 py-3">
                <div className="min-w-0"><div className="truncate text-sm font-medium text-white">{item.building_name}</div><div className="mt-1 text-[11px] text-zinc-500">{item.broker_obs} of {item.total_obs} captured building observations</div></div>
                <span className="shrink-0 text-sm font-bold text-emerald-300">{item.share_pct}%</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {!!broker.aliases?.length && (
        <section>
          <h3 className="text-sm font-semibold mb-2 text-zinc-500 uppercase tracking-wide">Also Seen As</h3>
          <div className="flex flex-wrap gap-2">
            {broker.aliases.slice(0, 12).map((alias) => (
              <span key={alias.alias} className="bg-zinc-900 px-2.5 py-1 rounded text-sm text-white">
                {alias.alias} <span className="text-[10px] text-zinc-500">{alias.observation_count}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {!!broker.observations?.length && (
        <section>
          <h3 className="text-sm font-semibold mb-2 text-zinc-500 uppercase tracking-wide">
            Recent Extracted Evidence
          </h3>
          <div className="space-y-1">
            {broker.observations.slice(0, 25).map((item) => (
              <div key={item.parsed_id} className="bg-zinc-900 rounded px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-white">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${item.role === "listing" ? "bg-blue-900/40 text-blue-200" : item.role === "requirement" ? "bg-amber-900/40 text-amber-200" : "bg-zinc-700 text-zinc-200"}`}>
                    {item.role || item.intent || "unknown"}
                  </span>
                  <span>{evidenceSummary(item)}</span>
                </div>
                <div className="text-xs text-zinc-500 mt-1">
                  {[formatPrice(item.price, item.price_unit), item.furnishing, displayGroupName(item.group_name), shortDate(item.seen_at || item.created_at)].filter(Boolean).join(" · ")}
                </div>
              </div>
            ))}
          </div>
        </section>
       )}

      <hr className="border-zinc-800" />
      <section>
        <NotesPanel entityType="broker" entityId={String(broker.id)} />
      </section>
    </div>
  );
}
