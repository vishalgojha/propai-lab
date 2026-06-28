"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import * as api from "@/lib/api";

function waLink(phone: string): string {
  const digits = phone?.replace(/\D/g, "");
  return digits ? `https://wa.me/${digits.startsWith("91") ? digits : "91" + digits}` : "#";
}

function maskPhone(phone: string): string {
  const digits = phone?.replace(/\D/g, "") || "";
  if (digits.length < 4) return phone || "—";
  return `••••••${digits.slice(-4)}`;
}

export default function BrokerProfilePage() {
  const params = useParams<{ id: string }>();
  const [broker, setBroker] = useState<any>(null);
  const [revealed, setRevealed] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (params.id) api.getBroker(Number(params.id)).then(setBroker);
  }, [params.id]);

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 2000);
  }

  if (!broker) return <div className="text-[#64748b] mt-8">Loading…</div>;

  return (
    <div className="max-w-4xl space-y-8">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-xl font-bold">{broker.name}</h2>
          <div className="text-sm text-[#64748b] mt-1">
            {broker.observation_count} messages · First seen {new Date(broker.first_seen_at).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
          </div>
        </div>
        <div className="flex gap-2 items-center">
          {revealed ? (
            <>
              <span className="text-sm text-[#e2e8f0] font-mono">{broker.phone}</span>
              <button
                onClick={() => copy(broker.phone)}
                className="text-xs px-2.5 py-1 rounded bg-[#1e293b] text-[#64748b] hover:text-white"
              >
                {copied === broker.phone ? "Copied!" : "Copy"}
              </button>
              <a
                href={waLink(broker.phone)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs px-2.5 py-1 rounded bg-[#166534] text-green-200 hover:bg-[#15803d]"
              >
                Open WhatsApp
              </a>
              <button
                onClick={() => setRevealed(false)}
                className="text-xs px-2.5 py-1 rounded bg-[#1e293b] text-[#64748b] hover:text-white"
              >
                Hide
              </button>
            </>
          ) : (
            <button
              onClick={() => setRevealed(true)}
              className="text-xs px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-500 font-medium"
            >
              Reveal Number
            </button>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-5 gap-4">
        {[
          { label: "Listings", value: broker.listing_count },
          { label: "Requirements", value: broker.requirement_count },
          { label: "Groups", value: broker.group_count },
          { label: "Markets", value: broker.market_count },
          { label: "Avg Ticket", value: broker.avg_ticket ? `₹${Math.round(broker.avg_ticket).toLocaleString("en-IN")}` : "—" },
        ].map((s) => (
          <div key={s.label} className="bg-[#0d1117] rounded-lg px-3 py-3 text-center">
            <div className="text-lg font-bold">{s.value}</div>
            <div className="text-[10px] text-[#64748b] uppercase tracking-wide mt-0.5">{s.label}</div>
          </div>
        ))}
      </div>

      {broker.aliases?.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2 text-[#64748b] uppercase tracking-wide">Also Known As</h3>
          <div className="flex flex-wrap gap-2">
            {broker.aliases.map((a: any, i: number) => (
              <span key={i} className="bg-[#0d1117] px-2.5 py-1 rounded text-sm text-[#e2e8f0]">
                {a.alias}
              </span>
            ))}
          </div>
        </section>
      )}

      {broker.phones?.length > 1 && (
        <section>
          <h3 className="text-sm font-semibold mb-2 text-[#64748b] uppercase tracking-wide">Phone Numbers</h3>
          <div className="space-y-1">
            {broker.phones.map((p: any, i: number) => (
              <div key={i} className="text-sm flex items-center gap-2">
                <span className="text-[#e2e8f0]">{maskPhone(p.phone)}</span>
                <span className="text-[10px] text-[#64748b]">{p.observation_count} messages</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {broker.markets?.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2 text-[#64748b] uppercase tracking-wide">Markets</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {broker.markets.map((m: any, i: number) => (
              <div key={i} className="bg-[#0d1117] rounded px-2.5 py-2">
                <div className="text-sm font-medium">{m.micro_market}</div>
                <div className="text-[10px] text-[#64748b]">
                  {m.listing_count} listings · {m.requirement_count} requirements
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {broker.buildings?.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2 text-[#64748b] uppercase tracking-wide">Buildings</h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {broker.buildings.map((b: any, i: number) => (
              <div key={i} className="bg-[#0d1117] rounded px-2.5 py-2">
                <div className="text-sm font-medium">{b.building_name}</div>
                <div className="text-[10px] text-[#64748b]">
                  {b.listing_count} listings · {b.requirement_count} requirements
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {broker.observations?.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold mb-2 text-[#64748b] uppercase tracking-wide">
            Recent Messages ({broker.observations.length})
          </h3>
          <div className="space-y-1">
            {broker.observations.slice(0, 20).map((o: any, i: number) => (
              <div key={i} className="bg-[#0d1117] rounded px-3 py-2 text-sm">
                <div className="text-[#e2e8f0]">
                  {o.intent === "listing" ? "🏗️" : "📋"}{" "}
                  {o.bhk && `${o.bhk} `}{o.building_name && `${o.building_name}, `}{o.micro_market || ""}
                </div>
                <div className="text-xs text-[#64748b] mt-0.5">
                  {o.price && `₹${Number(o.price).toLocaleString("en-IN")}`}{o.price_unit === "cr" ? " Cr" : ""}{" "}
                  {o.furnishing}{" "}
                  <span className="text-[10px]">{new Date(o.created_at).toLocaleDateString("en-IN", { day: "numeric", month: "short" })}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
