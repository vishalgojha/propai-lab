"use client";

import { useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import { formatBrokerPrice } from "@/lib/format";

type Channel = "whatsapp" | "facebook" | "instagram";

interface PromoteModalProps {
  observationId?: number;
  listing?: Partial<api.ListingRow>;
  parsed?: Record<string, unknown>;
  onClose: () => void;
}

interface FactFields {
  property: string;
  location: string;
  price: string;
  area: string;
  highlights: string;
  contact: string;
}

interface Draft {
  whatsapp: { message: string };
  facebook: { headline: string; description: string; highlights: string; cta: string };
  instagram: { caption: string; highlights: string; hashtags: string };
}

const channels: { id: Channel; label: string }[] = [
  { id: "whatsapp", label: "WhatsApp" },
  { id: "facebook", label: "Facebook" },
  { id: "instagram", label: "Instagram" },
];

function asString(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function formatPrice(value?: number | null, unit?: string | null): string {
  if (!value) return "";
  if (unit === "Cr" || unit === "crore") return `₹${(value / 10000000).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  if (unit === "L" || unit === "lakh") return `₹${(value / 100000).toLocaleString("en-IN", { maximumFractionDigits: 1 })} L`;
  return `₹${formatBrokerPrice(value)}`;
}

function buildInitialFields(source: Record<string, unknown>): FactFields {
  const property = [
    asString(source.bhk),
    asString(source.building_name),
    asString(source.furnishing),
  ].filter(Boolean).join(" ");
  const location = [
    asString(source.location_label) || asString(source.micro_market) || asString(source.location_raw),
    asString(source.landmark_name) ? `near ${asString(source.landmark_name)}` : "",
  ].filter(Boolean).join(", ");
  const price = formatPrice(Number(source.price) || null, asString(source.price_unit));
  const area = source.area_sqft ? `${Number(source.area_sqft).toLocaleString("en-IN")} sqft` : "";
  const contact = [
    asString(source.broker_name),
    asString(source.broker_phone),
  ].filter(Boolean).join(" · ");
  const highlights = [
    asString(source.bhk) && `${asString(source.bhk)} configuration`,
    asString(source.furnishing),
    asString(source.building_name) && `Building: ${asString(source.building_name)}`,
    asString(source.landmark_name) && `Near ${asString(source.landmark_name)}`,
  ].filter(Boolean).join("\n");
  return { property, location, price, area, highlights, contact };
}

function requiredMissing(fields: FactFields): string[] {
  const missing = [];
  if (!fields.price) missing.push("Price");
  if (!fields.location) missing.push("Location");
  if (!fields.area) missing.push("Area");
  return missing;
}

function cleanLines(value: string): string[] {
  return value.split("\n").map((line) => line.trim()).filter(Boolean);
}

function hashtags(fields: FactFields): string {
  const tags = ["#MumbaiRealEstate", "#PropertyForSale", "#RealEstateMumbai"];
  const locationTag = fields.location.split(/[, ]+/).find((part) => part.length > 3);
  if (locationTag) tags.push(`#${locationTag.replace(/[^a-z0-9]/gi, "")}`);
  return tags.join(" ");
}

function buildDraft(fields: FactFields): Draft {
  const highlights = cleanLines(fields.highlights);
  const highlightText = highlights.map((h) => `- ${h}`).join("\n");
  const shortHighlights = highlights.slice(0, 4).map((h) => `• ${h}`).join("\n");
  const property = fields.property || "Property";

  return {
    whatsapp: {
      message: [
        `*${property}*`,
        fields.location && `Location: ${fields.location}`,
        fields.price && `Price: ${fields.price}`,
        fields.area && `Area: ${fields.area}`,
        shortHighlights && `Highlights:\n${shortHighlights}`,
        fields.contact && `Contact: ${fields.contact}`,
      ].filter(Boolean).join("\n"),
    },
    facebook: {
      headline: `${property}${fields.location ? ` in ${fields.location}` : ""}`,
      description: [
        `${property} available${fields.location ? ` at ${fields.location}` : ""}.`,
        fields.price && `Price: ${fields.price}.`,
        fields.area && `Area: ${fields.area}.`,
      ].filter(Boolean).join(" "),
      highlights: highlightText,
      cta: fields.contact ? `Contact ${fields.contact} for details or a site visit.` : "Contact for details or a site visit.",
    },
    instagram: {
      caption: [
        `${property}${fields.location ? ` | ${fields.location}` : ""}`,
        fields.price && fields.price,
        fields.area && fields.area,
        "DM for details or site visit.",
      ].filter(Boolean).join("\n"),
      highlights: shortHighlights,
      hashtags: hashtags(fields),
    },
  };
}

function draftText(draft: Draft, channel: Channel): string {
  if (channel === "whatsapp") return draft.whatsapp.message;
  if (channel === "facebook") {
    return [
      draft.facebook.headline,
      draft.facebook.description,
      draft.facebook.highlights,
      draft.facebook.cta,
    ].filter(Boolean).join("\n\n");
  }
  return [
    draft.instagram.caption,
    draft.instagram.highlights,
    draft.instagram.hashtags,
  ].filter(Boolean).join("\n\n");
}

function parseNumber(value: string): number | undefined {
  const parsed = Number(value.replace(/[^0-9.]/g, ""));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

function backendFields(fields: FactFields, source: Record<string, unknown>) {
  const priceText = fields.price.toLowerCase();
  const priceBase = parseNumber(fields.price);
  const price =
    priceBase && priceText.includes("cr") ? priceBase * 10000000 :
    priceBase && (priceText.includes("lac") || priceText.includes("lakh") || /\sl\b/.test(priceText)) ? priceBase * 100000 :
    priceBase || source.price;

  return {
    bhk: source.bhk,
    price,
    price_unit: priceText.includes("cr") ? "Cr" : priceText.includes("lac") || priceText.includes("lakh") ? "L" : source.price_unit,
    area_sqft: parseNumber(fields.area) || source.area_sqft,
    furnishing: source.furnishing,
    location_raw: fields.location,
    building_name: source.building_name,
    landmark_name: source.landmark_name,
    micro_market: fields.location,
    broker_name: fields.contact,
    broker_phone: source.broker_phone,
  };
}

export default function PromoteModal({ observationId, listing, parsed, onClose }: PromoteModalProps) {
  const source = useMemo(() => ({ ...(parsed || {}), ...(listing || {}) }), [listing, parsed]);
  const [active, setActive] = useState<Channel>("whatsapp");
  const [fields, setFields] = useState<FactFields>(() => buildInitialFields(source));
  const [draft, setDraft] = useState<Draft>(() => buildDraft(buildInitialFields(source)));
  const [config, setConfig] = useState<api.PromoteConfig | null>(null);
  const [status, setStatus] = useState("");
  const missing = requiredMissing(fields);

  useEffect(() => {
    api.getPromoteConfig().then(setConfig).catch(() => setConfig({
      enable_ai_promo: false,
      enable_meta_publishing: false,
      meta_publish_available: false,
    }));
  }, []);

  function updateField(key: keyof FactFields, value: string) {
    setFields((prev) => ({ ...prev, [key]: value }));
  }

  async function generate() {
    if (missing.length > 0) {
      setStatus("Add the missing information before generating.");
      return;
    }

    const next = buildDraft(fields);
    if (config?.enable_ai_promo && observationId) {
      const overrides = backendFields(fields, source);
      const apiKey = typeof window !== "undefined" ? localStorage.getItem("doubleword_key") || "" : "";
      const [whatsapp, facebook, instagram] = await Promise.all(
        channels.map((channel) => api.promoteGenerate({
          observation_id: observationId,
          channel: channel.id,
          use_ai: true,
          fields: overrides,
          api_key: apiKey,
        }).catch(() => null))
      );
      if (whatsapp?.body) next.whatsapp.message = whatsapp.body;
      if (facebook) {
        next.facebook.headline = facebook.headline || next.facebook.headline;
        next.facebook.description = facebook.body || next.facebook.description;
        next.facebook.highlights = (facebook.highlights || []).map((h) => `- ${h}`).join("\n") || next.facebook.highlights;
      }
      if (instagram?.body) next.instagram.caption = instagram.body;
    }

    setDraft(next);
    setStatus("Promotion copy generated.");
  }

  async function copy(channel: Channel = active) {
    await navigator.clipboard.writeText(draftText(draft, channel));
    setStatus(`${channels.find((c) => c.id === channel)?.label} copy ready.`);
  }

  function downloadTxt() {
    const text = channels.map((channel) => `${channel.label}\n${draftText(draft, channel.id)}`).join("\n\n---\n\n");
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = "propai-listing-promotion.txt";
    link.click();
    URL.revokeObjectURL(url);
  }

  const copyShareLabel = config?.meta_publish_available ? "Publish" : "Copy & Share";

  return (
    <div className="fixed inset-0 z-50 bg-black/60">
      <div className="absolute right-0 top-0 h-full w-full max-w-3xl overflow-y-auto bg-[var(--color-bg-surface)] border-l border-[var(--color-border-strong)] shadow-2xl">
        <div className="sticky top-0 z-10 flex items-center justify-between gap-3 border-b border-[var(--color-border)] bg-[var(--color-bg-surface)] px-5 py-4">
          <div>
            <h2 className="text-base font-bold text-[var(--color-text-primary)]">Promote Listing</h2>
            <div className="text-xs text-[var(--color-text-muted)]">{copyShareLabel}</div>
          </div>
          <button onClick={onClose} className="rounded-lg border border-[var(--color-border-strong)] px-3 py-1.5 text-sm text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]">Close</button>
        </div>

        <div className="grid gap-5 p-5 lg:grid-cols-[280px_1fr]">
          <div className="space-y-3">
            <div className="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Listing Facts</div>
            {(["property", "location", "price", "area", "contact"] as (keyof FactFields)[]).map((key) => (
              <label key={key} className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{key}</span>
                <input
                  value={fields[key]}
                  onChange={(event) => updateField(key, event.target.value)}
                  className="w-full rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[#3EE88A]"
                />
              </label>
            ))}
            <label className="block">
              <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">highlights</span>
              <textarea
                value={fields.highlights}
                onChange={(event) => updateField("highlights", event.target.value)}
                rows={5}
                className="w-full resize-y rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm text-[var(--color-text-primary)] outline-none focus:border-[#3EE88A]"
              />
            </label>

            {missing.length > 0 && (
              <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-sm text-amber-200">
                <div className="font-semibold">Missing:</div>
                {missing.map((item) => <div key={item}>• {item}</div>)}
              </div>
            )}

            <button
              onClick={generate}
              className="w-full rounded-lg bg-[#3EE88A] px-3 py-2 text-sm font-bold text-black hover:bg-[#2DC96E]"
            >
              Generate Promotion
            </button>
          </div>

          <div className="min-w-0 space-y-4">
            <div className="flex flex-wrap gap-2">
              {channels.map((channel) => (
                <button
                  key={channel.id}
                  onClick={() => setActive(channel.id)}
                  className={`rounded-lg px-3 py-1.5 text-sm font-semibold ${active === channel.id ? "bg-[#3EE88A] text-black" : "border border-[var(--color-border-strong)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-hover)]"}`}
                >
                  {channel.label}
                </button>
              ))}
            </div>

            {active === "whatsapp" && (
              <label className="block">
                <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">message</span>
                <textarea value={draft.whatsapp.message} onChange={(event) => setDraft((prev) => ({ ...prev, whatsapp: { message: event.target.value } }))} rows={16} className="w-full resize-y rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm leading-relaxed text-[var(--color-text-primary)] outline-none focus:border-[#3EE88A]" />
              </label>
            )}

            {active === "facebook" && (
              <div className="space-y-3">
                {(["headline", "description", "highlights", "cta"] as (keyof Draft["facebook"])[]).map((key) => (
                  <label key={key} className="block">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{key}</span>
                    <textarea value={draft.facebook[key]} onChange={(event) => setDraft((prev) => ({ ...prev, facebook: { ...prev.facebook, [key]: event.target.value } }))} rows={key === "headline" ? 2 : 5} className="w-full resize-y rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm leading-relaxed text-[var(--color-text-primary)] outline-none focus:border-[#3EE88A]" />
                  </label>
                ))}
              </div>
            )}

            {active === "instagram" && (
              <div className="space-y-3">
                {(["caption", "highlights", "hashtags"] as (keyof Draft["instagram"])[]).map((key) => (
                  <label key={key} className="block">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">{key}</span>
                    <textarea value={draft.instagram[key]} onChange={(event) => setDraft((prev) => ({ ...prev, instagram: { ...prev.instagram, [key]: event.target.value } }))} rows={key === "hashtags" ? 3 : 7} className="w-full resize-y rounded-lg border border-[var(--color-border-strong)] bg-[var(--color-bg-elevated)] px-3 py-2 text-sm leading-relaxed text-[var(--color-text-primary)] outline-none focus:border-[#3EE88A]" />
                  </label>
                ))}
              </div>
            )}

            <div className="flex flex-wrap gap-2 border-t border-[var(--color-border)] pt-4">
              <button onClick={() => copy(active)} className="rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">Copy</button>
              <button onClick={() => copy("whatsapp")} className="rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">Copy WhatsApp</button>
              <button onClick={() => copy("instagram")} className="rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">Copy Instagram</button>
              <button onClick={() => copy("facebook")} className="rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">Copy Facebook</button>
              <button onClick={downloadTxt} className="rounded-lg border border-[var(--color-border-strong)] px-3 py-2 text-sm font-semibold text-[var(--color-text-primary)] hover:bg-[var(--color-bg-hover)]">Download TXT</button>
              {config?.meta_publish_available && (
                <button className="rounded-lg bg-[#3EE88A] px-3 py-2 text-sm font-bold text-black">Publish</button>
              )}
            </div>
            {status && <div className="text-xs text-[var(--color-text-muted)]">{status}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
