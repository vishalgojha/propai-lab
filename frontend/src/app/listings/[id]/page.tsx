"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import * as api from "@/lib/api";
import {
  MapPin,
  Building2,
  Phone,
  Tag,
  Calendar,
  Camera,
  MessageSquare,
  ArrowLeft,
  ExternalLink,
  Copy,
  Check,
} from "lucide-react";

function formatPrice(value?: number, unit?: string) {
  if (!value) return "—";
  if (value >= 10000000) return `${(value / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  if (value >= 100000) return `${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Lac`;
  if (unit) return `${value.toLocaleString("en-IN")} ${unit}`;
  return value.toLocaleString("en-IN");
}

function dateLabel(ts?: string) {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
}

function relativeDate(ts?: string) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffDays = Math.floor(diffMs / 86400000);
  if (diffDays === 0) return "today";
  if (diffDays === 1) return "yesterday";
  if (diffDays < 7) return `${diffDays}d ago`;
  if (diffDays < 30) return `${Math.floor(diffDays / 7)}w ago`;
  return dateLabel(ts);
}

function intentBadge(intent?: string) {
  if (!intent) return null;
  const cls =
    intent === "SELL"
      ? "bg-blue-900/50 text-blue-200"
      : intent === "RENT"
      ? "bg-green-900/50 text-green-200"
      : intent === "BUY"
      ? "bg-amber-900/50 text-amber-200"
      : "bg-zinc-700 text-zinc-200";
  return <span className={`text-[10px] px-2 py-0.5 rounded-full font-medium ${cls}`}>{intent}</span>;
}

function InfoRow({ label, value, link }: { label: string; value?: string | number | null; link?: string }) {
  if (!value && value !== 0) return null;
  return (
    <div className="flex items-baseline justify-between gap-2 py-1.5 border-b border-white/5 last:border-0">
      <span className="text-xs text-zinc-500 shrink-0">{label}</span>
      {link ? (
        <a href={link} target="_blank" rel="noreferrer" className="text-sm text-[#3EE88A] hover:underline flex items-center gap-1 truncate">
          {value} <ExternalLink className="h-3 w-3" />
        </a>
      ) : (
        <span className="text-sm text-white text-right truncate">{value}</span>
      )}
    </div>
  );
}

export default function ListingDetailPage() {
  const params = useParams<{ id: string }>();
  const [listing, setListing] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!params.id) return;
    setLoading(true);
    api
      .getListing(Number(params.id))
      .then((data) => {
        setListing(data);
        setError(null);
      })
      .catch(() => {
        setListing(null);
        setError("Listing not found");
      })
      .finally(() => setLoading(false));
  }, [params.id]);

  async function copyFingerprint() {
    if (!listing?.fingerprint) return;
    await navigator.clipboard.writeText(listing.fingerprint);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto py-12 text-center text-xs text-zinc-500">
        Loading listing...
      </div>
    );
  }

  if (error || !listing) {
    return (
      <div className="max-w-4xl mx-auto py-12 text-center">
        <div className="text-sm text-zinc-400">{error || "Listing not found"}</div>
        <Link href="/knowledge" className="mt-3 inline-flex items-center gap-1 text-xs text-[#3EE88A] hover:text-white">
          <ArrowLeft className="h-3 w-3" /> Back to Knowledge
        </Link>
      </div>
    );
  }

  const buildingLink = listing.building_name ? `/buildings/${encodeURIComponent(listing.building_name)}` : null;
  const brokerLink = listing.broker_name ? `/brokers?search=${encodeURIComponent(listing.broker_name)}` : null;
  const waPhone = listing.broker_phone?.replace(/\D/g, "").slice(-10);
  const waLink = waPhone && waPhone.length === 10 ? `https://wa.me/91${waPhone}` : null;
  const pricePerSqft =
    listing.price && listing.area_sqft ? Math.round(listing.price / listing.area_sqft) : null;

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <Link
          href="/knowledge"
          className="text-xs text-zinc-500 hover:text-white transition-colors flex items-center gap-1"
        >
          <ArrowLeft className="h-3 w-3" /> Knowledge
        </Link>

        <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              {intentBadge(listing.intent)}
              {listing.bhk && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-700 text-zinc-200 font-medium">
                  {listing.bhk}
                </span>
              )}
              {listing.property_type && (
                <span className="text-[10px] px-2 py-0.5 rounded-full bg-zinc-800 text-zinc-400">
                  {listing.property_type}
                </span>
              )}
            </div>

            <h1 className="mt-2 text-xl font-bold text-white leading-tight">
              {listing.building_name || listing.location_label || listing.micro_market || `Listing #${listing.id}`}
            </h1>

            <div className="mt-1 text-sm text-zinc-400 flex items-center gap-1.5">
              <MapPin className="h-3.5 w-3.5 shrink-0 text-zinc-500" />
              {listing.location_label || listing.micro_market || "Location not extracted"}
              {listing.landmark_name && <span className="text-zinc-600">· {listing.landmark_name}</span>}
            </div>
          </div>

          <div className="text-right shrink-0">
            <div className="text-2xl font-bold text-white">{formatPrice(listing.price, listing.price_unit)}</div>
            {pricePerSqft && (
              <div className="text-xs text-zinc-500 mt-0.5">₹{pricePerSqft.toLocaleString("en-IN")}/sqft</div>
            )}
          </div>
        </div>
      </div>

      {/* Property Details Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        {[
          { label: "Price", value: formatPrice(listing.price, listing.price_unit) },
          { label: "Area", value: listing.area_sqft ? `${listing.area_sqft.toLocaleString("en-IN")} sqft` : null },
          { label: "BHK", value: listing.bhk || null },
          { label: "Furnishing", value: listing.furnishing || null },
          { label: "Floor", value: listing.floor_description || null },
          { label: "Orientation", value: listing.orientation || null },
          { label: "View", value: listing.view || null },
          { label: "Source", value: listing.listing_source || null },
        ]
          .filter((c) => c.value)
          .slice(0, 4)
          .map((card) => (
            <div key={card.label} className="bg-zinc-900 rounded-lg px-3 py-3">
              <div className="text-lg font-bold text-white">{card.value}</div>
              <div className="text-[10px] text-zinc-500 uppercase tracking-wide mt-0.5">{card.label}</div>
            </div>
          ))}
      </div>

      {/* Two-column: Details + Broker */}
      <div className="grid gap-5 lg:grid-cols-2">
        {/* Property Details */}
        <section className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
          <h3 className="text-sm font-semibold text-white mb-2">Property Details</h3>
          <div>
            <InfoRow label="Intent" value={listing.intent || "—"} />
            <InfoRow label="Type" value={listing.property_type || listing.asset_type || "—"} />
            <InfoRow label="Transaction" value={listing.transaction_type || "—"} />
            <InfoRow label="BHK" value={listing.bhk || "—"} />
            <InfoRow label="Price" value={formatPrice(listing.price, listing.price_unit)} />
            {pricePerSqft && <InfoRow label="Per sqft" value={`₹${pricePerSqft.toLocaleString("en-IN")}`} />}
            <InfoRow label="Area" value={listing.area_sqft ? `${listing.area_sqft.toLocaleString("en-IN")} sqft` : "—"} />
            <InfoRow label="Furnishing" value={listing.furnishing || "—"} />
            <InfoRow label="Floor" value={listing.floor_description || "—"} />
            <InfoRow label="Orientation" value={listing.orientation || "—"} />
            <InfoRow label="View" value={listing.view || "—"} />
            <InfoRow label="Commercial use" value={listing.commercial_use_type || "—"} />
            <InfoRow label="Fitout" value={listing.fitout_status || "—"} />
            <InfoRow label="Occupancy" value={listing.occupancy_type || "—"} />
          </div>
        </section>

        {/* Location + Broker */}
        <section className="space-y-5">
          <div className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
            <h3 className="text-sm font-semibold text-white mb-2">Location</h3>
            <div>
              <InfoRow label="Building" value={listing.building_name || "—"} link={buildingLink || undefined} />
              <InfoRow label="Landmark" value={listing.landmark_name || "—"} />
              <InfoRow label="Micro market" value={listing.micro_market || "—"} />
              <InfoRow label="Street" value={listing.street_name || "—"} />
              <InfoRow label="Developer" value={listing.developer || "—"} />
              <InfoRow label="Location label" value={listing.location_label || "—"} />
            </div>
          </div>

          <div className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
            <h3 className="text-sm font-semibold text-white mb-2">Broker</h3>
            <div>
              <InfoRow label="Name" value={listing.broker_name || "—"} link={brokerLink || undefined} />
              <InfoRow label="Phone" value={listing.broker_phone || "—"} />
            </div>
            {waLink && (
              <a
                href={waLink}
                target="_blank"
                rel="noreferrer"
                className="mt-3 inline-flex items-center gap-1.5 text-xs font-bold px-3 py-2 rounded-lg bg-[#3EE88A] text-black hover:bg-[#2DC96E]"
              >
                <Phone className="h-3 w-3" /> Contact on WhatsApp
              </a>
            )}
          </div>
        </section>
      </div>

      {/* Timeline */}
      <section className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
        <h3 className="text-sm font-semibold text-white mb-3">Timeline</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="text-center">
            <div className="text-xs text-zinc-500">First seen</div>
            <div className="text-sm text-white mt-0.5">{dateLabel(listing.first_seen)}</div>
            <div className="text-[10px] text-zinc-600">{relativeDate(listing.first_seen)}</div>
          </div>
          <div className="text-center">
            <div className="text-xs text-zinc-500">Last seen</div>
            <div className="text-sm text-white mt-0.5">{dateLabel(listing.last_seen)}</div>
            <div className="text-[10px] text-zinc-600">{relativeDate(listing.last_seen)}</div>
          </div>
          <div className="text-center">
            <div className="text-xs text-zinc-500">Observations</div>
            <div className="text-lg font-bold text-white mt-0.5">{listing.observation_count || 0}</div>
          </div>
          <div className="text-center">
            <div className="text-xs text-zinc-500">Groups</div>
            <div className="text-lg font-bold text-white mt-0.5">{listing.group_count || 0}</div>
          </div>
        </div>
      </section>

      {/* Fingerprint */}
      {listing.fingerprint && (
        <section className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-white">Fingerprint</h3>
              <p className="text-[10px] text-zinc-500 mt-0.5">Unique identifier for this listing across groups and time.</p>
            </div>
            <button
              onClick={copyFingerprint}
              className="flex items-center gap-1 text-xs px-2.5 py-1.5 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white"
            >
              {copied ? <Check className="h-3 w-3 text-[#3EE88A]" /> : <Copy className="h-3 w-3" />}
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <code className="mt-2 block text-xs text-zinc-400 break-all bg-black/30 rounded px-2.5 py-1.5">
            {listing.fingerprint}
          </code>
        </section>
      )}

      {/* Raw Message */}
      {listing.raw_message && (
        <section className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
          <h3 className="text-sm font-semibold text-white mb-2 flex items-center gap-1.5">
            <MessageSquare className="h-3.5 w-3.5 text-zinc-500" /> Original Message
          </h3>
          <div className="bg-black/30 rounded-lg p-3 text-sm text-zinc-300 whitespace-pre-wrap leading-relaxed">
            {listing.raw_message.content}
          </div>
          <div className="mt-2 text-[10px] text-zinc-500 flex flex-wrap gap-3">
            {listing.raw_message.sender_name && <span>From: {listing.raw_message.sender_name}</span>}
            {listing.raw_message.group_name && <span>Group: {listing.raw_message.group_name}</span>}
            {listing.raw_message.timestamp && <span>{dateLabel(listing.raw_message.timestamp)}</span>}
          </div>
        </section>
      )}

      {/* Source Observations */}
      {listing.sources?.length > 0 && (
        <section className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
          <h3 className="text-sm font-semibold text-white mb-3">
            Source Observations ({listing.sources.length})
          </h3>
          <div className="space-y-1.5">
            {listing.sources.map((src: any) => (
              <div key={src.id} className="bg-zinc-900 rounded px-3 py-2">
                <div className="flex flex-wrap items-center gap-2 text-sm text-white">
                  <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                    src.role === "listing"
                      ? "bg-blue-900/40 text-blue-200"
                      : src.role === "requirement"
                      ? "bg-amber-900/40 text-amber-200"
                      : "bg-zinc-700 text-zinc-200"
                  }`}>
                    {src.role || src.intent || "unknown"}
                  </span>
                  <span>{src.bhk || ""} {src.building_name || ""} {src.micro_market || ""}</span>
                  {src.price ? <span className="text-zinc-400 text-xs">{formatPrice(src.price, src.price_unit)}</span> : null}
                </div>
                <div className="text-[10px] text-zinc-500 mt-1 flex flex-wrap gap-3">
                  {src.furnishing && <span>{src.furnishing}</span>}
                  {src.confidence && <span>conf: {Math.round(src.confidence * 100)}%</span>}
                  {src.created_at && <span>{dateLabel(src.created_at)}</span>}
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Photos */}
      {listing.photos?.length > 0 && (
        <section className="rounded-lg border border-white/10 bg-white/[0.025] p-4">
          <h3 className="text-sm font-semibold text-white mb-3 flex items-center gap-1.5">
            <Camera className="h-3.5 w-3.5 text-zinc-500" /> Photos ({listing.photos.length})
          </h3>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {listing.photos.map((photo: any) => (
              <div key={photo.id} className="relative aspect-square bg-zinc-800 rounded-lg overflow-hidden">
                <img
                  src={photo.url}
                  alt={photo.caption || "Listing photo"}
                  className="w-full h-full object-cover"
                  loading="lazy"
                />
                {photo.caption && (
                  <div className="absolute bottom-0 inset-x-0 bg-black/60 text-[10px] text-zinc-300 px-2 py-1 truncate">
                    {photo.caption}
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Quick Links */}
      <div className="flex flex-wrap gap-2 pb-8">
        {buildingLink && (
          <Link
            href={buildingLink}
            className="text-xs px-3 py-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white flex items-center gap-1"
          >
            <Building2 className="h-3 w-3" /> Building Profile
          </Link>
        )}
        {listing.micro_market && (
          <Link
            href={`/localities/${encodeURIComponent(listing.micro_market)}`}
            className="text-xs px-3 py-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white flex items-center gap-1"
          >
            <MapPin className="h-3 w-3" /> {listing.micro_market}
          </Link>
        )}
        {listing.latest_raw_message_id && (
          <Link
            href={`/observations/${listing.latest_raw_message_id}`}
            className="text-xs px-3 py-2 rounded-lg bg-zinc-800 text-zinc-400 hover:text-white flex items-center gap-1"
          >
            <Tag className="h-3 w-3" /> Latest Observation
          </Link>
        )}
      </div>
    </div>
  );
}
