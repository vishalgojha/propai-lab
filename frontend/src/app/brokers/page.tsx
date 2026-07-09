"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import * as api from "@/lib/api";

type BrokerMarket = {
  micro_market: string;
  observation_count: number;
  listing_count: number;
  requirement_count: number;
};

type BrokerGroup = {
  group_name: string;
  observation_count: number;
  listing_count: number;
  requirement_count: number;
  last_seen_at: string;
};

type BrokerRow = {
  id: number;
  name: string;
  phone?: string;
  observation_count: number;
  listing_count: number;
  requirement_count: number;
  group_count: number;
  market_count: number;
  last_seen_at?: string;
  markets?: BrokerMarket[];
  groups?: BrokerGroup[];
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

function sourceLabel(broker: BrokerRow) {
  if (broker.name && !isMaskedName(broker.name)) return broker.name;
  if (validPhone(broker.phone)) return displayPhone(broker.phone);
  return "Unknown WhatsApp source";
}

function sourceSubtext(broker: BrokerRow) {
  if (broker.name && isMaskedName(broker.name)) return "Masked WhatsApp display identity";
  if (!validPhone(broker.phone)) return "No usable phone captured yet";
  return displayPhone(broker.phone);
}

function activityMix(broker: BrokerRow) {
  const supply = broker.listing_count || 0;
  const demand = broker.requirement_count || 0;
  if (supply === 0 && demand === 0) return { label: "Unclassified", tone: "bg-zinc-700 text-zinc-200" };
  if (supply >= demand * 3) return { label: "Supply source", tone: "bg-blue-900/40 text-blue-200" };
  if (demand >= supply * 2) return { label: "Demand source", tone: "bg-amber-900/40 text-amber-200" };
  return { label: "Balanced source", tone: "bg-green-900/40 text-green-200" };
}

function dateLabel(ts?: string) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short" });
}

function marketSummary(markets: BrokerMarket[] = []) {
  return markets.slice(0, 3).map((m) => m.micro_market).filter(Boolean);
}

function groupSummary(groups: BrokerGroup[] = []) {
  return groups.slice(0, 2).map((g) => g.group_name).filter(Boolean);
}

export default function BrokersPage() {
  const [brokers, setBrokers] = useState<BrokerRow[]>([]);
  const [query, setQuery] = useState("");

  useEffect(() => {
    api.getBrokers().then(setBrokers);
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return brokers;
    return brokers.filter((broker) => {
      const text = [
        broker.name,
        broker.phone,
        ...(broker.markets || []).map((m) => m.micro_market),
        ...(broker.groups || []).map((g) => g.group_name),
      ].join(" ").toLowerCase();
      return text.includes(q);
    });
  }, [brokers, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-white">Broker Sources</h2>
          <div className="text-sm text-zinc-500 mt-1">
            WhatsApp sources with extracted supply, demand, operating areas, groups, and recent activity.
          </div>
        </div>
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search broker, market, group..."
          className="px-2.5 py-1.5 bg-zinc-900 border border-white/10 rounded-lg text-sm text-white min-w-[280px]"
        />
      </div>

      {filtered.length === 0 ? (
        <div className="text-zinc-500">No broker source data yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Source</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Mix</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Operating Areas</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Groups</th>
                <th className="text-right px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Supply</th>
                <th className="text-right px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Demand</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Last Active</th>
                <th className="text-left px-2.5 py-2 border-b border-white/10 text-[11px] text-zinc-500 uppercase">Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((broker) => {
                const mix = activityMix(broker);
                const markets = marketSummary(broker.markets);
                const groups = groupSummary(broker.groups);
                const whatsapp = waLink(broker.phone);

                return (
                  <tr key={broker.id} className="hover:bg-zinc-900">
                    <td className="px-2.5 py-2 border-b border-white/10">
                      <Link href={`/brokers/${broker.id}`} className="font-semibold text-white hover:text-blue-400 transition-colors">
                        {sourceLabel(broker)}
                      </Link>
                      <div className="text-[10px] text-zinc-500 mt-0.5">{sourceSubtext(broker)}</div>
                    </td>
                    <td className="px-2.5 py-2 border-b border-white/10">
                      <span className={`text-[10px] px-2 py-1 rounded-full font-semibold ${mix.tone}`}>{mix.label}</span>
                    </td>
                    <td className="px-2.5 py-2 border-b border-white/10 min-w-[220px]">
                      {markets.length ? (
                        <div className="flex flex-wrap gap-1">
                          {markets.map((market) => (
                            <span key={market} className="text-[10px] bg-zinc-800 border border-white/10 rounded px-1.5 py-0.5 text-zinc-400">{market}</span>
                          ))}
                          {broker.market_count > markets.length && <span className="text-[10px] text-zinc-500">+{broker.market_count - markets.length}</span>}
                        </div>
                      ) : (
                        <span className="text-[#475569]">No area extracted</span>
                      )}
                    </td>
                    <td className="px-2.5 py-2 border-b border-white/10 min-w-[220px]">
                      {groups.length ? (
                        <div className="space-y-0.5">
                          {groups.map((group) => <div key={group} className="text-xs text-zinc-400 truncate max-w-[260px]">{group}</div>)}
                          {broker.group_count > groups.length && <div className="text-[10px] text-zinc-500">+{broker.group_count - groups.length} more groups</div>}
                        </div>
                      ) : (
                        <span className="text-[#475569]">-</span>
                      )}
                    </td>
                    <td className="px-2.5 py-2 border-b border-white/10 text-right font-mono">{broker.listing_count}</td>
                    <td className="px-2.5 py-2 border-b border-white/10 text-right font-mono">{broker.requirement_count}</td>
                    <td className="px-2.5 py-2 border-b border-white/10 text-zinc-500 text-xs">{dateLabel(broker.last_seen_at)}</td>
                    <td className="px-2.5 py-2 border-b border-white/10">
                      <div className="flex flex-wrap gap-1.5">
                        <Link href={`/brokers/${broker.id}`} className="text-[10px] font-semibold text-white bg-[#58a6ff] hover:bg-[#4090e0] rounded px-2 py-1">
                          Profile
                        </Link>
                        {whatsapp ? (
                          <a href={whatsapp} target="_blank" rel="noreferrer" className="text-[10px] font-semibold text-black bg-[#3EE88A] hover:bg-[#2DC96E] rounded px-2 py-1">
                            WhatsApp
                          </a>
                        ) : (
                          <span className="text-[10px] text-zinc-500">No WA</span>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
