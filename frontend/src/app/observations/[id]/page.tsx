"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import * as api from "@/lib/api";
import { formatBrokerPrice } from "@/lib/format";
import PromoteModal from "@/components/PromoteModal";
import { displayGroupName } from "@/lib/whatsapp-display";

function istDate(ts: string | null | undefined): string {
  if (!ts) return "";
  try {
    const d = new Date(ts.endsWith("Z") ? ts : ts + "Z");
    return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "short", timeStyle: "short" });
  } catch {
    return "";
  }
}

function fmtPrice(price: number | null | undefined, unit?: string | null): string {
  if (price == null) return "";
  if (unit === "L" || unit === "lakh") return `₹${(price / 100000).toLocaleString("en-IN")} L`;
  if (unit === "Cr" || unit === "crore") return `₹${(price / 10000000).toLocaleString("en-IN")} Cr`;
  return formatBrokerPrice(price);
}

function fmtArea(area: number | null | undefined): string | null {
  if (area == null) return null;
  return `${area.toLocaleString("en-IN")} sqft`;
}

const intentBadge: Record<string, string> = {
  SELL: "badge-green", BUY: "badge-purple", RENT: "badge-yellow",
  COMMERCIAL: "badge-orange", "PRE-LAUNCH": "badge-red",
};

function ListingCard({ listing, idx }: { listing: any; idx: number }) {
  const details: string[] = [];
  if (listing.bhk) details.push(listing.bhk);
  const areaStr = fmtArea(listing.area_sqft);
  if (areaStr) details.push(areaStr);
  if (listing.furnishing) details.push(listing.furnishing);

  return (
    <div className="border border-[var(--border-strong)] rounded-xl p-3.5">
      <div className="flex items-center gap-2 flex-wrap">
        {listing.listing_index !== undefined && (
          <span className="text-[10px] text-[var(--text-muted)] font-mono">#{listing.listing_index + 1}</span>
        )}
        {listing.intent && (
          <span className={`badge ${intentBadge[listing.intent] || "badge-blue"}`}>{listing.intent}</span>
        )}
      </div>
      <div className="mt-1.5">
        {details.length > 0 && (
          <div className="text-xs text-[var(--text-secondary)]">{details.join(" · ")}</div>
        )}
        {listing.price != null && (
          <div className="text-lg font-bold text-[var(--text-primary)] mt-1">
            {listing.price_unit ? fmtPrice(listing.price, listing.price_unit) : formatBrokerPrice(listing.price)}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ObservationPage() {
  const params = useParams();
  const id = params.id as string;
  const [obs, setObs] = useState<any>(null);
  const [error, setError] = useState("");
  const [showRaw, setShowRaw] = useState(true);
  const [showPromote, setShowPromote] = useState(false);

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
      <div className="max-w-2xl mx-auto py-8">
        <div className="text-red-500 text-center py-10 bg-[var(--bg-surface)] border border-[var(--border)] rounded-2xl">{error}</div>
      </div>
    );
  }

  if (!obs) {
    return (
      <div className="max-w-2xl mx-auto py-8">
        <div className="text-[var(--text-muted)] text-center py-10">Loading...</div>
      </div>
    );
  }

  const raw = obs.raw || {};
  const parsed = obs.parsed || {};
  const resolver = obs.resolver || {};
  const listings: any[] = obs.listings?.length ? obs.listings : (parsed.id ? [parsed] : []);

  const buildingName = resolver.building_name || parsed.building_name;
  const landmark = resolver.landmark_name || parsed.landmark_name;
  const brokerName = parsed.broker_name || raw.sender || "";
  const phoneClean = (parsed.broker_phone || "").replace(/[^0-9]/g, "").slice(-10);
  const waLink = phoneClean.length === 10 ? `https://wa.me/91${phoneClean}` : "";
  const displayPhone = phoneClean.length === 10 ? `+91 ${phoneClean.slice(0, 2)} XXXXX ${phoneClean.slice(-2)}` : parsed.broker_phone;
  const hasContact = brokerName || displayPhone;

  return (
    <div className="max-w-2xl mx-auto">
      <a href={document.referrer || "/"} className="text-xs text-[var(--blue)] no-underline hover:underline">&larr; Back</a>

      <div className="bg-[var(--bg-surface)] border border-[var(--border)] rounded-2xl p-5 mt-3">
        <div className="flex items-center gap-2 flex-wrap">
          {listings.length > 0 && (
            <span className="text-[10px] text-[var(--text-muted)] font-mono">{listings.length} listing{listings.length !== 1 ? "s" : ""}</span>
          )}
          <span className="text-xs text-[var(--text-muted)]">{displayGroupName(raw.group_name) || raw.source || ""}</span>
          {listings.length > 0 && (
            <button
              onClick={() => setShowPromote(true)}
              className="ml-auto bg-[#3EE88A] hover:bg-[#2DC96E] text-black text-xs font-bold px-3 py-1.5 rounded-lg cursor-pointer"
            >
              Promote
            </button>
          )}
          <span className={`text-xs text-[var(--text-muted)] ${listings.length > 0 ? "" : "ml-auto"}`}>{istDate(raw.timestamp)}</span>
        </div>

        {(buildingName || landmark) && (
          <div className="mt-3 text-xs text-[var(--text-secondary)] space-y-0.5">
            {buildingName && <div className="text-base font-bold text-[var(--text-primary)]">{buildingName}</div>}
            {landmark && <div>{landmark}</div>}
          </div>
        )}

        {listings.length > 0 && (
          <div className={`mt-3 ${listings.length === 1 ? "" : "grid grid-cols-1 sm:grid-cols-2 gap-2.5"}`}>
            {listings.map((l, i) => (
              <ListingCard key={l.id || i} listing={l} idx={i} />
            ))}
          </div>
        )}

        {(hasContact || raw.message) && <div className="border-t border-[var(--border)] my-3" />}

        {hasContact && (
          <div className="flex items-center justify-between gap-3">
            <div className="min-w-0">
              {brokerName && <div className="text-sm font-semibold text-[var(--text-primary)] truncate">{brokerName}</div>}
              {displayPhone && <div className="text-xs text-[var(--text-secondary)]">{displayPhone}</div>}
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {waLink && (
                <a href={waLink} target="_blank" rel="noopener noreferrer" className="bg-green-600 hover:bg-green-700 text-white text-xs font-semibold px-3 py-1.5 rounded-lg no-underline">Chat on WhatsApp</a>
              )}
            </div>
          </div>
        )}

        {(hasContact || raw.message) && <div className="border-t border-[var(--border)] my-3" />}

        {raw.message && (
          <div>
            <button onClick={() => setShowRaw(s => !s)} className="text-[10px] text-[var(--text-muted)] uppercase tracking-wider font-bold cursor-pointer">{showRaw ? "▲ Hide" : "▼ Show"} original message</button>
            {showRaw && (
              <div className="mt-2 p-3 bg-[var(--bg-elevated)] border border-[var(--border-strong)] rounded-lg text-xs whitespace-pre-wrap text-[var(--text-primary)] leading-relaxed">{raw.message}</div>
            )}
          </div>
        )}
      </div>

      {showPromote && (
        <PromoteModal
          observationId={parseInt(id.replace(/^P/, ""))}
          listing={listings[0]}
          parsed={parsed}
          onClose={() => setShowPromote(false)}
        />
      )}
    </div>
  );
}
