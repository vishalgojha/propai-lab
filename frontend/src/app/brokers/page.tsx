"use client";

export const dynamic = 'force-dynamic';

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import * as api from "@/lib/api";
import { Building2, MapPin, Users, MessageSquare, Activity, Phone, Clock, CheckCircle, XCircle, HelpCircle } from "lucide-react";

type BrokerMarket = {
  micro_market: string;
  observation_count: number;
  listing_count: number;
  requirement_count: number;
};

type BrokerBuilding = {
  building_name: string;
  listing_count: number;
  requirement_count: number;
  observation_count: number;
};

type BrokerGroup = {
  group_name: string;
  observation_count: number;
  listing_count: number;
  requirement_count: number;
  last_seen_at: string;
};

type BrokerPhone = {
  phone: string;
  observation_count: number;
  first_seen_at: string;
  last_seen_at: string;
};

type BrokerAlias = {
  alias: string;
  observation_count: number;
  first_seen_at: string;
  last_seen_at: string;
};

type BrokerRecentObs = {
  id: number;
  intent: string;
  bhk?: string;
  price?: number;
  price_unit?: string;
  micro_market?: string;
  building_name?: string;
  landmark_name?: string;
  created_at: string;
};

type Broker = {
  id: number;
  identity_key: string;
  canonical_name: string;
  primary_phone: string;
  observation_count: number;
  listing_count: number;
  requirement_count: number;
  rental_count: number;
  commercial_count: number;
  group_count: number;
  market_count: number;
  building_count: number;
  active_days_30: number;
  first_seen_at: string;
  last_seen_at: string;
  markets: BrokerMarket[];
  buildings: BrokerBuilding[];
  groups: BrokerGroup[];
  phones: BrokerPhone[];
  aliases: BrokerAlias[];
  recent_observations: BrokerRecentObs[];
};

function digits(value?: string) {
  return (value || "").replace(/\D/g, "");
}

function validPhone(phone?: string) {
  return digits(phone).slice(-10).length === 10;
}

function waLink(phone?: string) {
  const local = digits(phone).slice(-10);
  if (local.length !== 10) return "";
  return `https://wa.me/91${local}`;
}

function displayPhone(phone?: string) {
  const local = digits(phone).slice(-10);
  if (local.length !== 10) return "";
  return `+91 ${local.slice(0, 5)} ${local.slice(5)}`;
}

function isMaskedName(name?: string) {
  return /^\+\d/.test(name || "") || /X{3,}/i.test(name || "");
}

function formatRelativeTime(ts?: string) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  const diff = Date.now() - d.getTime();
  const mins = Math.floor(diff / 60000);
  const hrs = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  if (hrs < 24) return `${hrs}h ago`;
  if (days < 7) return `${days}d ago`;
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function activityMix(broker: Broker) {
  const supply = broker.listing_count || 0;
  const demand = broker.requirement_count || 0;
  if (supply === 0 && demand === 0) return { label: "Unclassified", tone: "bg-zinc-700 text-zinc-200" };
  if (supply >= demand * 3) return { label: "Supply", tone: "bg-blue-900/40 text-blue-200" };
  if (demand >= supply * 2) return { label: "Demand", tone: "bg-amber-900/40 text-amber-200" };
  return { label: "Balanced", tone: "bg-green-900/40 text-green-200" };
}

export default function BrokersPage() {
  const [brokers, setBrokers] = useState<Broker[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.getBrokers()
      .then((data) => {
        setBrokers(data || []);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return brokers;
    return brokers.filter((broker) => {
      const text = [
        broker.canonical_name,
        broker.primary_phone,
        ...broker.markets.map((m) => m.micro_market),
        ...broker.buildings.map((b) => b.building_name),
        ...broker.groups.map((g) => g.group_name),
        ...broker.aliases.map((a) => a.alias),
      ].join(" ").toLowerCase();
      return text.includes(q);
    });
  }, [brokers, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Brokers</h2>
          <div className="text-sm text-zinc-500 mt-1">
            {brokers.length} broker profiles · Filter by name, market, building, group, or alias
          </div>
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search broker, market, building, group, alias..."
          className="px-2.5 py-1.5 bg-zinc-900 border border-white/10 rounded-lg text-sm text-white min-w-[300px]"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12 text-zinc-500">Loading brokers…</div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-12 text-zinc-500">
          <HelpCircle className="w-8 h-8 mx-auto text-zinc-600 mb-2" />
          <div className="text-sm">No broker data yet</div>
          <div className="text-xs text-zinc-500 mt-1">Broker profiles appear as WhatsApp messages are processed</div>
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {filtered.map((broker) => {
            const mix = activityMix(broker);
            const whatsapp = waLink(broker.primary_phone);
            const hasWhatsApp = validPhone(broker.primary_phone);
            const topMarkets = broker.markets.slice(0, 3).map((m) => m.micro_market).filter(Boolean);
            const topBuildings = broker.buildings.slice(0, 2).map((b) => b.building_name).filter(Boolean);
            const topGroups = broker.groups.slice(0, 2).map((g) => g.group_name).filter(Boolean);
            const recentObs = broker.recent_observations.slice(0, 2);

            return (
              <Link key={broker.id} href={`/brokers/${broker.id}`} className="group">
                <article className="rounded-2xl border border-white/10 bg-zinc-950/50 p-4 hover:border-emerald-400/30 hover:bg-zinc-900/50 transition-all">
                  {/* Header */}
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div className="flex-1 min-w-0">
                      <h3 className="font-semibold text-white truncate group-hover:text-emerald-400 transition-colors">
                        {broker.canonical_name || displayPhone(broker.primary_phone)}
                      </h3>
                      <div className="flex items-center gap-2 mt-1 text-xs text-zinc-500">
                        {hasWhatsApp && (
                          <a href={whatsapp} target="_blank" rel="noreferrer" className="flex items-center gap-1 text-emerald-400 hover:text-emerald-300" onClick={(e) => e.stopPropagation()}>
                            <Phone className="w-3 h-3" />
                            <span>WhatsApp</span>
                          </a>
                        )}
                        {!hasWhatsApp && <span className="flex items-center gap-1 text-zinc-500"><XCircle className="w-3 h-3" /> No WA</span>}
                        <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold ${mix.tone}`}>{mix.label}</span>
                      </div>
                    </div>
                  </div>

                  {/* Stats Row */}
                  <div className="grid grid-cols-4 gap-2 mb-3 text-center">
                    <div className="rounded-lg bg-zinc-800/50 px-2 py-1.5">
                      <div className="text-white font-bold text-sm">{broker.listing_count}</div>
                      <div className="text-[10px] text-zinc-500">Listings</div>
                    </div>
                    <div className="rounded-lg bg-zinc-800/50 px-2 py-1.5">
                      <div className="text-white font-bold text-sm">{broker.requirement_count}</div>
                      <div className="text-[10px] text-zinc-500">Reqs</div>
                    </div>
                    <div className="rounded-lg bg-zinc-800/50 px-2 py-1.5">
                      <div className="text-white font-bold text-sm">{broker.market_count}</div>
                      <div className="text-[10px] text-zinc-500">Markets</div>
                    </div>
                    <div className="rounded-lg bg-zinc-800/50 px-2 py-1.5">
                      <div className="text-white font-bold text-sm">{broker.building_count}</div>
                      <div className="text-[10px] text-zinc-500">Buildings</div>
                    </div>
                  </div>

                  {/* Markets */}
                  {topMarkets.length > 0 && (
                    <div className="mb-3">
                      <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-1">Markets</div>
                      <div className="flex flex-wrap gap-1">
                        {topMarkets.map((market) => (
                          <span key={market} className="text-[10px] bg-zinc-800 border border-white/10 rounded px-1.5 py-0.5 text-zinc-400">{market}</span>
                        ))}
                        {broker.market_count > topMarkets.length && (
                          <span className="text-[10px] text-zinc-500">+{broker.market_count - topMarkets.length}</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Buildings */}
                  {topBuildings.length > 0 && (
                    <div className="mb-3">
                      <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-1">Buildings</div>
                      <div className="flex flex-wrap gap-1">
                        {topBuildings.map((building) => (
                          <span key={building} className="text-[10px] bg-zinc-800 border border-blue-500/20 rounded px-1.5 py-0.5 text-blue-300">{building}</span>
                        ))}
                        {broker.building_count > topBuildings.length && (
                          <span className="text-[10px] text-zinc-500">+{broker.building_count - topBuildings.length}</span>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Groups */}
                  {topGroups.length > 0 && (
                    <div className="mb-3">
                      <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-1">Groups</div>
                      <div className="space-y-0.5">
                        {topGroups.map((group) => (
                          <div key={group} className="text-xs text-zinc-400 truncate">{group}</div>
                        ))}
                        {broker.group_count > topGroups.length && (
                          <div className="text-[10px] text-zinc-500">+{broker.group_count - topGroups.length} more groups</div>
                        )}
                      </div>
                    </div>
                  )}

                  {/* Recent Activity */}
                  {recentObs.length > 0 && (
                    <div className="mb-3 p-2 rounded-lg bg-zinc-900/50 border border-white/5">
                      <div className="text-[10px] font-medium text-zinc-500 uppercase tracking-wider mb-1">Recent Activity</div>
                      <div className="space-y-1">
                        {recentObs.map((obs) => (
                          <div key={obs.id} className="text-xs text-zinc-400 flex items-center gap-1.5">
                            <span className={`px-1 py-0.5 rounded text-[9px] font-medium ${
                              obs.intent === "SELL" ? "bg-blue-900/40 text-blue-200" :
                              obs.intent === "RENT" ? "bg-green-900/40 text-green-200" :
                              obs.intent === "BUY" ? "bg-purple-900/40 text-purple-200" :
                              "bg-zinc-700 text-zinc-200"
                            }`}>{obs.intent}</span>
                            {obs.bhk && <span>{obs.bhk}</span>}
                            {obs.micro_market && <span className="text-emerald-400">{obs.micro_market}</span>}
                            {obs.building_name && <span className="text-blue-400">{obs.building_name}</span>}
                            {obs.price && <span className="text-amber-400">{formatPrice(obs.price, obs.price_unit)}</span>}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {/* Footer */}
                  <div className="pt-3 border-t border-white/10 flex items-center justify-between">
                    <div className="text-xs text-zinc-500">
                      <Clock className="w-3 h-3 inline-block align-middle mr-1" />
                      {formatRelativeTime(broker.last_seen_at)}
                    </div>
                    <Link
                      href={`/brokers/${broker.id}`}
                      className="text-[11px] font-semibold text-white bg-emerald-400 hover:bg-emerald-400/80 rounded px-2.5 py-1 transition-colors"
                      onClick={(e) => e.stopPropagation()}
                    >
                      View Profile
                    </Link>
                  </div>
                </article>
              </Link>
            ))}
        </div>
      )}
    </div>
  );
}

function formatPrice(price?: number, unit?: string) {
  if (!price) return "";
  if (unit === "Cr" || price >= 100) return `₹${(price / 100).toFixed(1)}Cr`;
  return `₹${price.toLocaleString()}L`;
}