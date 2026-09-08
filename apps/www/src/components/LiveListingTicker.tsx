"use client";

import { useEffect, useRef, useState } from "react";
import { cleanPublicText } from "../lib/listing-card";

type LatestListing = {
  id: number;
  bhk: string | null;
  price: number | null;
  priceUnit: string | null;
  furnishing: string | null;
  assetType: string | null;
  transactionType: string | null;
  building: string | null;
  microMarket: string | null;
  locality: string | null;
  broker: string | null;
  lastSeen: string | null;
};

const POLL_INTERVAL_MS = 30_000;

function timeAgo(iso: string | null, now: number): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return `${h}h ago`;
}

function priceLabel(price: number | null, unit: string | null): string | null {
  if (price == null || !Number.isFinite(price) || price <= 0) return null;
  const u = String(unit || "").toLowerCase();
  // Typed public rows expose absolute rupees with priceUnit=abs.
  const absolute = u.includes("cr") || u.includes("crore")
    ? price >= 1_00_00_000 ? price : price * 1_00_00_000
    : u.includes("lac") || u.includes("lakh")
      ? price >= 1_00_000 ? price : price * 1_00_000
      : u.includes("k") || u.includes("thousand")
        ? price >= 1_000 ? price : price * 1_000
        : price;
  if (absolute >= 1_00_00_000) {
    const cr = absolute / 1_00_00_000;
    return `₹${cr % 1 === 0 ? cr : cr.toFixed(2)} Cr`;
  }
  if (absolute >= 1_00_000) {
    const lakh = absolute / 1_00_000;
    return `₹${lakh % 1 === 0 ? lakh : lakh.toFixed(2)} Lakh`;
  }
  if (absolute >= 1_000) return `₹${Math.round(absolute).toLocaleString("en-IN")}`;
  return null;
}

export default function LiveListingTicker() {
  const [listing, setListing] = useState<LatestListing | null>(null);
  const [prevId, setPrevId] = useState<number | null>(null);
  const [fresh, setFresh] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      try {
        const res = await fetch("/api/latest-listing");
        if (!res.ok) return;
        const json = (await res.json()) as { listing: LatestListing | null };
        if (!active) return;
        const l = json.listing;
        setNow(Date.now());
        if (l && l.id !== prevId) {
          setPrevId(l.id);
          setListing(l);
          if (prevId !== null) {
            setFresh(true);
            window.setTimeout(() => active && setFresh(false), 2500);
          }
        }
      } catch {
        /* keep last known listing on transient errors */
      }
    };

    poll();
    timer.current = setInterval(poll, POLL_INTERVAL_MS);
    const clock = setInterval(() => setNow(Date.now()), 1000);

    return () => {
      active = false;
      if (timer.current) clearInterval(timer.current);
      clearInterval(clock);
    };
  }, [prevId]);

  if (!listing) return null;

  const price = priceLabel(listing.price, listing.priceUnit);
  const asset = listing.assetType?.toLowerCase() === "commercial" ? "Commercial" : "Residential";
  const type = listing.transactionType
    ? `${asset} ${listing.transactionType.toLowerCase() === "rent" ? "rental" : "sale"}`
    : asset;
  const building = cleanPublicText(listing.building);

  return (
    <div
      className={`mt-10 mb-6 flex items-center justify-center gap-3 text-sm transition-opacity duration-500 ${
        fresh ? "opacity-100" : "opacity-90"
      }`}
      aria-live="polite"
    >
      <span
        className={`inline-block h-2 w-2 rounded-full ${
          fresh ? "bg-green-400 animate-pulse" : "bg-zinc-500"
        }`}
        aria-hidden="true"
      />
      <span className="text-zinc-500">
        Just landed{listing.lastSeen ? ` · ${timeAgo(listing.lastSeen, now)}` : ""}:
      </span>
      <span className="font-medium text-white">
        {type}
        {price ? ` — ${price}` : ""}
        {listing.locality ? ` in ${listing.locality}` : ""}
        {building ? ` (${building})` : ""}
      </span>
    </div>
  );
}
