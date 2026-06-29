"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import * as api from "@/lib/api";

function maskPhone(phone: string): string {
  const digits = phone?.replace(/\D/g, "") || "";
  if (digits.length < 4) return phone || "—";
  return `••••••${digits.slice(-4)}`;
}

function waLink(phone: string): string {
  const digits = phone?.replace(/\D/g, "") || "";
  if (digits.length < 10) return "";
  return `https://wa.me/${digits.startsWith("91") ? digits : "91" + digits}`;
}

export default function BrokersPage() {
  const [brokers, setBrokers] = useState<any[]>([]);
  const [revealed, setRevealed] = useState<Record<number, boolean>>({});

  useEffect(() => {
    api.getBrokers().then(setBrokers);
  }, []);

  function toggleReveal(id: number) {
    setRevealed((prev) => ({ ...prev, [id]: !prev[id] }));
  }

  return (
    <div>
      <h2 className="text-lg font-bold mb-4">Brokers</h2>
      {brokers.length === 0 ? (
        <div className="text-[#64748b]">No broker data yet</div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Name</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Contact</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Listings</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Buyers</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Groups</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Markets</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Avg Ticket</th>
                <th className="text-left px-2.5 py-2 border-b border-[rgba(255,255,255,0.1)] text-[11px] text-[#64748b] uppercase">Last Seen</th>
              </tr>
            </thead>
            <tbody>
              {brokers.map((b: any, i: number) => (
                <tr key={b.id || i} className="hover:bg-[#0d1117]">
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] font-semibold">
                    <Link href={`/brokers/${b.id}`} className="hover:text-blue-400 transition-colors">{b.name}</Link>
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">
                    {revealed[b.id] ? (
                      <span className="flex items-center gap-2">
                        <span className="text-[#e2e8f0]">{b.phone}</span>
                        <a
                          href={waLink(b.phone)}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-[10px] text-green-400 hover:text-green-300 font-medium"
                        >
                          Connect
                        </a>
                        <button
                          onClick={() => toggleReveal(b.id)}
                          className="text-[10px] text-[#64748b] hover:text-white"
                        >
                          Hide
                        </button>
                      </span>
                    ) : (
                      <span className="flex items-center gap-2">
                        <span className="text-[#64748b]">{maskPhone(b.phone)}</span>
                        <button
                          onClick={() => toggleReveal(b.id)}
                          className="text-[10px] text-blue-400 hover:text-blue-300 font-medium"
                        >
                          Reveal
                        </button>
                      </span>
                    )}
                  </td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{b.listing_count}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{b.requirement_count}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{b.group_count}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{b.market_count}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)]">{b.avg_ticket ? `₹${Math.round(b.avg_ticket).toLocaleString("en-IN")}` : "—"}</td>
                  <td className="px-2.5 py-2 border-b border-[rgba(255,255,255,0.06)] text-[#64748b] text-xs">{b.last_seen_at ? new Date(b.last_seen_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" }) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
