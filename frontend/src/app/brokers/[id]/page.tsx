"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import * as api from "@/lib/api";

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
  if (value >= 100000) return `${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Lac`;
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

function StatCard({ label, value, sub }: { label: string; value: string | number; sub?: string }) {
  return (
    <div className="bg-[#0d1117] rounded-lg px-3 py-3">
      <div className="text-xl font-bold text-[#e2e8f0]">{value}</div>
      <div className="text-[10px] text-[#64748b] uppercase tracking-wide mt-0.5">{label}</div>
      {sub ? <div className="text-[10px] text-[#475569] mt-1">{sub}</div> : null}
    </div>
  );
}

function SourceBar({ listing, requirement }: { listing: number; requirement: number }) {
  const total = Math.max(1, listing + requirement);
  const listingPct = Math.round((listing / total) * 100);
  return (
    <div>
      <div className="flex h-2 overflow-hidden rounded-full bg-[#111820]">
        <div className="bg-blue-500" style={{ width: `${listingPct}%` }} />
        <div className="bg-amber-500" style={{ width: `${100 - listingPct}%` }} />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-[#64748b]">
        <span>{listing} supply</span>
        <span>{requirement} demand</span>
      </div>
    </div>
  );
}

export default function BrokerProfilePage() {
  const params = useParams<{ id: string }>();
  const [broker, setBroker] = useState<BrokerProfile | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (params.id) api.getBroker(Number(params.id)).then(setBroker);
  }, [params.id]);

  async function copyPhone() {
    if (!broker?.phone) return;
    await navigator.clipboard.writeText(displayPhone(broker.phone) || broker.phone);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (!broker) return <div className="text-[#64748b] mt-8">Loading...</div>;

  const whatsapp = waLink(broker.phone);

  return (
    <div className="max-w-6xl space-y-7">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <Link href="/brokers" className="text-xs text-[#64748b] hover:text-white">Back to Broker Sources</Link>
          <h2 className="text-2xl font-bold mt-2">{sourceName(broker)}</h2>
          <div className="text-sm text-[#64748b] mt-1">
            {sourceSubtitle(broker)} · first seen {dateLabel(broker.first_seen_at)} · last active {dateLabel(broker.last_seen_at)}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {validPhone(broker.phone) ? (
            <>
              <button onClick={copyPhone} className="text-xs px-3 py-2 rounded-lg bg-[#111820] text-[#94a3b8] hover:text-white">
                {copied ? "Copied" : "Copy phone"}
              </button>
              {whatsapp && (
                <a href={whatsapp} target="_blank" rel="noreferrer" className="text-xs px-3 py-2 rounded-lg bg-[#3EE88A] text-[#04100a] font-bold hover:bg-[#2DC96E]">
                  WhatsApp
                </a>
              )}
            </>
          ) : (
            <span className="text-xs px-3 py-2 rounded-lg bg-[#111820] text-[#64748b]">No WhatsApp CTA until a real phone is captured</span>
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

      <section className="bg-[#0d1117] rounded-lg p-4">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
          <div>
            <h3 className="text-sm font-semibold text-[#e2e8f0]">Source Mix</h3>
            <div className="text-xs text-[#64748b] mt-0.5">{mixLabel(broker)}</div>
          </div>
          <div className="flex gap-2 text-[10px] text-[#64748b]">
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-blue-500" /> Supply</span>
            <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-amber-500" /> Demand</span>
          </div>
        </div>
        <SourceBar listing={broker.listing_count} requirement={broker.requirement_count} />
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section>
          <h3 className="text-sm font-semibold mb-2 text-[#64748b] uppercase tracking-wide">Operating Areas</h3>
          <div className="space-y-2">
            {(broker.markets || []).slice(0, 12).map((market) => (
              <div key={market.micro_market} className="bg-[#0d1117] rounded px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-[#e2e8f0]">{market.micro_market}</div>
                  <div className="text-[10px] text-[#64748b]">{market.observation_count} posts</div>
                </div>
                <SourceBar listing={market.listing_count} requirement={market.requirement_count} />
              </div>
            ))}
            {!broker.markets?.length && <div className="text-sm text-[#64748b]">No market extracted yet.</div>}
          </div>
        </section>

        <section>
          <h3 className="text-sm font-semibold mb-2 text-[#64748b] uppercase tracking-wide">Groups Seen In</h3>
          <div className="space-y-2">
            {(broker.groups || []).slice(0, 12).map((group) => (
              <div key={group.group_name} className="bg-[#0d1117] rounded px-3 py-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-sm font-medium text-[#e2e8f0] truncate">{group.group_name}</div>
                  <div className="text-[10px] text-[#64748b] whitespace-nowrap">{shortDate(group.last_seen_at)}</div>
                </div>
                <div className="text-[10px] text-[#64748b] mt-1">
                  {group.observation_count} posts · {group.listing_count} supply · {group.requirement_count} demand
                </div>
              </div>
            ))}
            {!broker.groups?.length && <div className="text-sm text-[#64748b]">No groups extracted yet.</div>}
          </div>
        </section>
      </div>

      {!!broker.buildings?.length && (
        <section>
          <h3 className="text-sm font-semibold mb-2 text-[#64748b] uppercase tracking-wide">Buildings Mentioned</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {broker.buildings.slice(0, 18).map((building) => (
              <div key={building.building_name} className="bg-[#0d1117] rounded px-2.5 py-2">
                <div className="text-sm font-medium">{building.building_name}</div>
                <div className="text-[10px] text-[#64748b]">
                  {building.listing_count} supply · {building.requirement_count} demand · {building.observation_count} posts
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!!broker.aliases?.length && (
        <section>
          <h3 className="text-sm font-semibold mb-2 text-[#64748b] uppercase tracking-wide">Also Seen As</h3>
          <div className="flex flex-wrap gap-2">
            {broker.aliases.slice(0, 12).map((alias) => (
              <span key={alias.alias} className="bg-[#0d1117] px-2.5 py-1 rounded text-sm text-[#e2e8f0]">
                {alias.alias} <span className="text-[10px] text-[#64748b]">{alias.observation_count}</span>
              </span>
            ))}
          </div>
        </section>
      )}

      {!!broker.observations?.length && (
        <section>
          <h3 className="text-sm font-semibold mb-2 text-[#64748b] uppercase tracking-wide">
            Recent Extracted Evidence
          </h3>
          <div className="space-y-1">
            {broker.observations.slice(0, 25).map((item) => (
              <div key={item.parsed_id} className="bg-[#0d1117] rounded px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2 text-[#e2e8f0]">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${item.role === "listing" ? "bg-blue-900/40 text-blue-200" : item.role === "requirement" ? "bg-amber-900/40 text-amber-200" : "bg-zinc-700 text-zinc-200"}`}>
                    {item.role || item.intent || "unknown"}
                  </span>
                  <span>{evidenceSummary(item)}</span>
                </div>
                <div className="text-xs text-[#64748b] mt-1">
                  {[formatPrice(item.price, item.price_unit), item.furnishing, item.group_name, shortDate(item.seen_at || item.created_at)].filter(Boolean).join(" · ")}
                </div>
              </div>
            ))}
          </div>
        </section>
       )}
    </div>
  );
}
