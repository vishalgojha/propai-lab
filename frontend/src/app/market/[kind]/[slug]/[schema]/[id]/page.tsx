"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import * as api from "@/lib/api";
import { Card } from "@/components/ui/card";
import { Building2, CheckCircle2, ChevronLeft, CircleAlert, MapPin, MessageSquare, Tag, UserRound } from "lucide-react";

function label(value: unknown) {
  return String(value ?? "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

function text(value: unknown) {
  return String(value ?? "").trim();
}

function displayValue(value: unknown, key: string) {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    const isMoney = key.includes("price") || key.includes("rent") || key.includes("asking");
    if (isMoney) return `₹${value.toLocaleString("en-IN")}`;
    const suffix = key.includes("area") || key.includes("sqft") ? " sqft" : "";
    return `${value.toLocaleString("en-IN")}${suffix}`;
  }
  if (Array.isArray(value)) return value.filter(Boolean).join(", ");
  return text(value).replace(/[_-]+/g, " ").replace(/\s+/g, " ");
}

const FIELD_GROUPS = [
  {
    title: "Deal",
    keys: [["bhk", "Configuration"], ["price_formatted", "Price"], ["total_asking_price", "Asking price"], ["monthly_rent", "Monthly rent"], ["furnishing_status", "Furnishing"], ["possession_status", "Possession"]],
  },
  {
    title: "Property",
    keys: [["area_sqft", "Area"], ["carpet_area_sqft", "Carpet area"], ["built_up_area_sqft", "Built-up area"], ["floor_range", "Floor"], ["wing", "Wing"], ["parking_type", "Parking"], ["car_parking_count", "Parking spaces"]],
  },
  {
    title: "People",
    keys: [["broker_name", "Broker"], ["broker_company", "Company"]],
  },
] as const;

export default function MarketRecordPage() {
  const params = useParams<{ kind: string; slug: string; schema: string; id: string }>();
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
  const [contactingBroker, setContactingBroker] = useState(false);
  const [contactError, setContactError] = useState("");
  const recordId = Number(params.id);
  const invalidUrl = !Number.isInteger(recordId) || recordId < 1 || !params.schema;
  const schema = (() => {
    try {
      return decodeURIComponent(params.schema || "");
    } catch {
      return "";
    }
  })();

  useEffect(() => {
    if (invalidUrl || !schema) return;
    api.getMarketItemDetails(recordId, schema)
      .then((data) => setRecord(data as Record<string, unknown>))
      .catch(() => setError("Market record not found"));
  }, [invalidUrl, recordId, schema]);

  if (invalidUrl || !schema) return <div className="market-record-page min-h-screen p-8 text-sm">Invalid market record URL</div>;
  if (error) return <div className="market-record-page min-h-screen p-8 text-sm">{error}</div>;
  if (!record) return <div className="market-record-page min-h-screen p-8 text-sm">Loading market record...</div>;

  const title = text(record.summary_title) || text(record.building_name) || text(record.micro_market) || `${label(params.kind)} #${params.id}`;
  const source = text(record.source_slice_text) || text(record.source_message);
  const address = text(record.building_address);
  const locality = text(record.micro_market) || text(record.locality_resolved) || text(record.locality_raw);
  const isRequirement = text(record.observation_type).toUpperCase() === "REQUIREMENT";
  const statusNeedsReview = record.needs_review === true || text(record.extraction_confidence).toLowerCase() === "low";
  const groups = FIELD_GROUPS.map((group) => ({
    ...group,
    fields: group.keys.map(([key, name]) => ({ key, name, value: displayValue(record[key], key) })).filter((field) => field.value),
  })).filter((group) => group.fields.length);
  const rawMessageId = Number(record.latest_raw_message_id || record.raw_message_id || 0) || undefined;

  async function contactBroker() {
    setContactingBroker(true);
    setContactError("");
    const contactWindow = window.open("", "_blank");
    try {
      const { contact_url } = await api.resolveBrokerContact(
        recordId,
        schema,
        rawMessageId,
      );
      if (contactWindow) {
        contactWindow.opener = null;
        contactWindow.location.assign(contact_url);
      } else {
        window.location.assign(contact_url);
      }
    } catch (reason) {
      contactWindow?.close();
      setContactError(reason instanceof Error ? reason.message : "Broker contact could not be opened.");
    } finally {
      setContactingBroker(false);
    }
  }

  return (
    <main className="market-record-page min-h-[calc(100dvh-44px)] w-full px-4 py-6 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-7xl">
        <Link href="/inbox" className="market-record-back inline-flex items-center gap-1 text-sm hover:underline"><ChevronLeft className="h-4 w-4" />Market Inbox</Link>
        <header className="mt-6 flex flex-col gap-5 border-b border-border-subtle pb-6 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2 text-xs font-semibold uppercase tracking-[0.16em] text-emerald-700">
              <span>{isRequirement ? "Requirement" : "Listing"}</span><span className="text-slate-400">·</span><span>{text(record.transaction_type) || label(params.kind)}</span>
            </div>
            <h1 className="market-record-title mt-2 max-w-4xl text-2xl font-semibold leading-tight sm:text-3xl">{title}</h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-sm text-slate-600">
              {locality && <span className="inline-flex items-center gap-1.5"><MapPin className="h-4 w-4 text-emerald-700" />{locality}</span>}
              {address && <span className="inline-flex items-center gap-1.5"><Building2 className="h-4 w-4 text-emerald-700" />{address}</span>}
              <span className="text-xs text-slate-500">#{params.id}</span>
            </div>
          </div>
          <div className={`inline-flex shrink-0 items-center gap-2 self-start rounded-full border px-3 py-1.5 text-xs font-semibold ${statusNeedsReview ? "border-amber-300 bg-amber-50 text-amber-800" : "border-emerald-300 bg-emerald-50 text-emerald-800"}`}>
            {statusNeedsReview ? <CircleAlert className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
            {statusNeedsReview ? "Needs review" : "Source checked"}
          </div>
        </header>

        <div className="grid gap-6 py-7 lg:grid-cols-[minmax(0,1fr)_360px]">
          <section className="space-y-6">
            <Card className="market-record-card p-5 sm:p-6">
              <div className="flex items-center justify-between gap-3 border-b border-border-subtle pb-4"><div><h2 className="text-lg font-semibold text-slate-900">What the broker needs to know</h2><p className="mt-1 text-xs text-slate-500">The working facts for this opportunity</p></div><Tag className="h-5 w-5 text-emerald-700" /></div>
              <div className="mt-5 grid gap-7 md:grid-cols-2">
                {groups.map((group) => <div key={group.title}><h3 className="text-xs font-bold uppercase tracking-[0.14em] text-slate-500">{group.title}</h3><dl className="mt-2 divide-y divide-slate-200">{group.fields.map((field) => <div key={field.key} className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] gap-4 py-3 text-sm"><dt className="text-slate-500">{field.name}</dt><dd className="min-w-0 break-words text-right font-medium text-slate-900">{field.value}</dd></div>)}</dl></div>)}
              </div>
            </Card>
            <Card className="market-record-card p-5 sm:p-6"><div className="flex items-center gap-2"><MessageSquare className="h-4 w-4 text-emerald-700" /><h2 className="text-lg font-semibold text-slate-900">WhatsApp evidence</h2></div><p className="mt-1 text-xs text-slate-500">The source message behind this structured record</p><div className="market-record-source mt-4 whitespace-pre-wrap rounded-lg bg-slate-50 p-4 text-sm leading-7 text-slate-800">{source || "Source text unavailable"}</div></Card>
          </section>
          <aside className="space-y-6">
            <Card className="market-record-card p-5"><div className="flex items-center gap-2"><MapPin className="h-4 w-4 text-emerald-700" /><h2 className="text-base font-semibold text-slate-900">Location</h2></div><div className="mt-4 space-y-3 text-sm"><div><div className="text-xs uppercase tracking-wide text-slate-500">Building</div><div className="mt-1 font-medium text-slate-900">{text(record.building_name) || "Not named in source"}</div></div><div><div className="text-xs uppercase tracking-wide text-slate-500">Verified address</div><div className="mt-1 leading-6 text-slate-700">{address || "Building enrichment pending"}</div></div></div></Card>
            <Card className="market-record-card p-5"><div className="flex items-center gap-2"><UserRound className="h-4 w-4 text-emerald-700" /><h2 className="text-base font-semibold text-slate-900">Broker</h2></div><div className="mt-4 text-sm"><div className="font-medium text-slate-900">{text(record.broker_name) || "Broker not resolved"}</div><button type="button" onClick={contactBroker} disabled={contactingBroker} className="mt-3 inline-flex items-center gap-2 rounded-md border border-emerald-700 bg-emerald-700 px-3 py-2 text-xs font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-wait disabled:opacity-60" aria-busy={contactingBroker}>{contactingBroker ? "Opening WhatsApp…" : "WhatsApp broker"}</button>{contactError && <p className="mt-2 text-xs leading-5 text-rose-700" role="alert">{contactError}</p>}</div></Card>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-xs leading-5 text-slate-600"><CircleAlert className="mb-2 h-4 w-4 text-emerald-700" />Building address appears here only after the Google Places enrichment worker verifies the building name with its locality context.</div>
          </aside>
        </div>
      </div>
    </main>
  );
}
