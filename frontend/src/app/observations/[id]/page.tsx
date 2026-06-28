"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import * as api from "@/lib/api";

function formatPrice(value?: number | null) {
  if (!value) return "";
  if (value >= 10000000) {
    return `${(value / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  }
  if (value >= 100000) {
    return `${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Lac`;
  }
  if (value >= 1000) {
    return `${(value / 1000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} K`;
  }
  return value.toLocaleString("en-IN");
}

function intentClass(intent: string) {
  return ({
    SELL: "badge-green",
    SELLER: "badge-green",
    BUY: "badge-purple",
    BUYER: "badge-purple",
    REQUIREMENT: "badge-purple",
    RENT: "badge-yellow",
    RENTAL: "badge-yellow",
    RENTAL_SEEKER: "badge-yellow",
    COMMERCIAL: "badge-orange",
    COMMERCIAL_SALE: "badge-orange",
    COMMERCIAL_RENTAL: "badge-orange",
    "PRE-LAUNCH": "badge-red",
  } as Record<string, string>)[intent] || "badge-blue";
}

export default function ObservationPage() {
  const params = useParams();
  const id = params.id as string;
  const [obs, setObs] = useState<any>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!id) return;
    const numId = parseInt(id.replace(/^P/, ""));
    if (!numId) { setError("Invalid ID"); return; }
    api.getObservation(numId)
      .then(setObs)
      .catch(e => setError(e.message));
  }, [id]);

  if (error) {
    return (
      <div className="max-w-3xl mx-auto py-8">
        <div className="text-red-500 text-center py-10 bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl">
          {error}
        </div>
      </div>
    );
  }

  if (!obs) {
    return (
      <div className="max-w-3xl mx-auto py-8">
        <div className="text-[#64748b] text-center py-10">Loading...</div>
      </div>
    );
  }

  const raw = obs.raw || {};
  const parsed = obs.parsed || {};
  const resolver = obs.resolver || {};
  const cans = (resolver.candidates || []).sort((a: any, b: any) => b.confidence - a.confidence);
  const intentColor = intentClass(parsed.intent);
  const phoneClean = (parsed.broker_phone || "").replace(/[^0-9]/g, "").slice(-10);
  const waLink = phoneClean.length === 10 ? `https://wa.me/91${phoneClean}` : "";
  const confPct = resolver.final_confidence ?? parsed.confidence ?? 0;
  const confColor = confPct > 0.7 ? "text-green-500" : confPct > 0.3 ? "text-yellow-500" : "text-red-500";

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      <h1 className="text-xl font-bold">Observation #{raw.id || `P${parsed.id}`}</h1>

      {/* ── Original Message ── */}
      <Section title="Original WhatsApp Message">
        <KV label="Group" value={raw.group_name} />
        <KV label="Broker" value={parsed.broker_name || raw.sender} />
        {waLink && (
          <div className="flex">
            <span className="text-[#8b949e] min-w-[130px] text-sm">WhatsApp</span>
            <span className="text-[#c9d1d9] text-sm">
              +91 {phoneClean.slice(0, 2)}XXXXX{phoneClean.slice(-2)}{" "}
              <a href={waLink} target="_blank" className="text-[#3b82f6] no-underline hover:underline">[Open wa.me]</a>
            </span>
          </div>
        )}
        <KV label="Time" value={raw.timestamp ? new Date(raw.timestamp + "Z").toLocaleString() : ""} />
        <KV label="Source" value={raw.source} />
        <KV label="Forwarded" value={parsed.forwarded ? "Yes" : "No"} />
        <div className="mt-4 bg-[#0d1117] border border-[#30363d] rounded-md p-4 text-sm whitespace-pre-wrap text-[#c9d1d9] leading-relaxed">
          {raw.message || "—"}
        </div>
      </Section>

      {/* ── Extraction ── */}
      <Section title="Extraction">
        <div className="grid grid-cols-2 gap-x-6 gap-y-2">
          <KV label="Intent" value={parsed.intent ? <><span className={`badge ${intentColor}`}>{parsed.intent}</span><span className="prov prov-parsed ml-1">Parsed</span></> : "—"} />
          <KV label="Principal" value={parsed.principal ? <>{parsed.principal}<span className="prov prov-parsed ml-1">Parsed</span></> : "—"} />
          <KV label="Broker" value={parsed.broker_name ? <>{parsed.broker_name}<span className="prov prov-parsed ml-1">Parsed</span></> : raw.sender || "—"} />
          <KV label="Phone" value={parsed.broker_phone ? <>{parsed.broker_phone}<span className="prov prov-parsed ml-1">Parsed</span></> : "—"} />
          <KV label="Building" value={parsed.building_name ? <>{parsed.building_name}<span className="prov prov-parsed ml-1">Parsed</span></> : "—"} />
          <KV label="BHK" value={parsed.bhk ? <>{parsed.bhk}<span className="prov prov-parsed ml-1">Parsed</span></> : "—"} />
          <KV label="Price" value={parsed.price ? <>{formatPrice(Number(parsed.price))}<span className="prov prov-parsed ml-1">Parsed</span></> : "—"} />
          <KV label="Area" value={parsed.area_sqft ? <>{`${parsed.area_sqft.toLocaleString()} sqft`}<span className="prov prov-parsed ml-1">Parsed</span></> : "—"} />
          <KV label="Furnishing" value={parsed.furnishing ? <>{parsed.furnishing}<span className="prov prov-parsed ml-1">Parsed</span></> : "—"} />
          <KV label="Location" value={parsed.location_raw ? <>{parsed.location_raw}<span className="prov prov-parsed ml-1">Parsed</span></> : "—"} />
          <KV label="Micro Market" value={parsed.micro_market ? <>{parsed.micro_market}<span className="prov prov-enriched ml-1">Enriched</span></> : "—"} />
          <KV label="Landmark" value={parsed.landmark_name ? <>{parsed.landmark_name}<span className="prov prov-enriched ml-1">Enriched</span></> : "—"} />
        </div>
        <div className="mt-4 text-right">
          <span className={`text-2xl font-bold ${confColor}`}>{(confPct * 100).toFixed(0)}%</span>
          <span className="text-[#64748b] text-sm ml-2">confidence</span>
        </div>
      </Section>

      {/* ── Resolution ── */}
      {resolver.id && (
        <Section title="Resolution">
          <div className="grid grid-cols-2 gap-x-6 gap-y-2">
            <KV label="Matched Building" value={resolver.building_name || "—"} />
            <KV label="Landmark" value={resolver.landmark_name || "—"} />
            <KV label="Method" value={resolver.method || "—"} />
            <KV label="Detail" value={resolver.method_detail || "—"} />
            {resolver.failure_category && <KV label="Failure" value={<span className="text-red-500">{resolver.failure_category}</span>} />}
          </div>

          {/* Confidence breakdown */}
          <div className="mt-4 flex gap-4">
            {[
              { label: "Parser", value: resolver.parser_confidence },
              { label: "Resolver", value: resolver.resolver_confidence },
              { label: "Final", value: resolver.final_confidence },
            ].map(s => {
              const pct = s.value != null ? (s.value * 100).toFixed(0) : "—";
              const color = s.value != null && s.value > 0.7 ? "green" : s.value != null && s.value > 0.3 ? "yellow" : "red";
              return (
                <div key={s.label} className="flex-1 bg-[#0d1117] border border-[#30363d] rounded-md p-3 text-center">
                  <div className="text-[10px] text-[#8b949e] uppercase tracking-wider">{s.label}</div>
                  <div className={`text-xl font-bold text-${color}-500`}>{pct}%</div>
                </div>
              );
            })}
          </div>

          {/* Candidates */}
          {cans.length > 0 && (
            <div className="mt-4">
              <div className="text-xs text-[#8b949e] uppercase tracking-wider mb-2">Candidates</div>
              <div className="space-y-1">
                {cans.map((c: any, i: number) => (
                  <div key={i} className="flex items-center gap-3 text-sm bg-[#0d1117] border border-[#30363d] rounded px-3 py-1.5">
                    <span className="font-medium text-[#c9d1d9]">{c.name}</span>
                    <span className="text-[#64748b]">{(c.confidence * 100).toFixed(0)}%</span>
                    {c.method && <span className="text-[#8b949e] text-xs">{c.method}</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Section>
      )}

      {/* ── Timeline ── */}
      <Section title="Timeline">
        {[
          { event: "Message received", time: raw.timestamp, icon: "📥" },
          { event: "Parsed", time: parsed.created_at, icon: "🔍" },
          { event: resolver.building_name ? "Building matched" : "Resolution attempted", time: resolver.created_at, icon: "⚖️" },
          { event: "Indexed", time: resolver.created_at, icon: "📌" },
        ].filter(s => s.time).map((s, i) => (
          <div key={i} className="flex items-center gap-3 py-1.5 text-sm">
            <span>{s.icon}</span>
            <span className="text-[#64748b] min-w-[140px]">{s.event}</span>
            <span className="text-[#c9d1d9]">{new Date(s.time + "Z").toLocaleTimeString()}</span>
          </div>
        ))}
        {!raw.timestamp && !parsed.created_at && <div className="text-[#64748b] text-sm">Timeline unavailable</div>}
      </Section>

      {/* ── AI Actions ── */}
      <Section title="AI (Optional)">
        <div className="flex gap-2 flex-wrap">
          <AIAction href={`/api/ai/explain/${raw.id}`} label="Explain this extraction" />
          <AIAction href={`/api/ai/similar/${raw.id}`} label="Find similar listings" />
          <AIAction href={`/api/ai/broker/${encodeURIComponent(parsed.broker_name || "")}`} label="Broker summary" disabled={!parsed.broker_name} />
        </div>
        <div className="text-[10px] text-[#64748b] mt-3">
          AI is optional. Everything above this line is deterministic.
        </div>
      </Section>
    </div>
  );
}

/* ── Helpers ── */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="bg-[#0d1117] border border-[rgba(255,255,255,0.06)] rounded-2xl p-5">
      <div className="text-[11px] text-[#64748b] uppercase tracking-widest font-bold mb-4 pb-2 border-b border-[rgba(255,255,255,0.06)]">
        {title}
      </div>
      {children}
    </div>
  );
}

function KV({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex">
      <span className="text-[#8b949e] min-w-[130px] text-sm">{label}</span>
      <span className="text-[#c9d1d9] text-sm">{value ?? "—"}</span>
    </div>
  );
}

function AIAction({ href, label, disabled }: { href: string; label: string; disabled?: boolean }) {
  if (disabled) {
    return <span className="px-3 py-1.5 bg-[#111820] border border-[rgba(255,255,255,0.06)] rounded-lg text-xs text-[#64748b] opacity-50 cursor-default">{label}</span>;
  }
  return (
    <a href={href} target="_blank" className="px-3 py-1.5 bg-[#111820] border border-[rgba(255,255,255,0.1)] rounded-lg text-xs text-[#58a6ff] no-underline hover:bg-[#141c26]">
      {label}
    </a>
  );
}
