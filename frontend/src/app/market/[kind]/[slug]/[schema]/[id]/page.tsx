"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import * as api from "@/lib/api";

function label(value: unknown) {
  return String(value ?? "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (character) => character.toUpperCase())
    .trim();
}

export default function MarketRecordPage() {
  const params = useParams<{ kind: string; slug: string; schema: string; id: string }>();
  const [record, setRecord] = useState<Record<string, unknown> | null>(null);
  const [error, setError] = useState("");
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

  if (invalidUrl || !schema) return <div className="mx-auto max-w-4xl p-8 text-sm text-text-muted">Invalid market record URL</div>;
  if (error) return <div className="mx-auto max-w-4xl p-8 text-sm text-text-muted">{error}</div>;
  if (!record) return <div className="mx-auto max-w-4xl p-8 text-sm text-text-muted">Loading market record...</div>;

  const text = (value: unknown) => String(value ?? "").trim();
  const title = text(record.summary_title) || text(record.building_name) || text(record.micro_market) || `${label(params.kind)} #${params.id}`;
  const source = text(record.source_slice_text) || text(record.source_message);
  const hidden = new Set(["raw_payload", "ai_extraction", "contacts", "broker_phone", "sender_phone", "source_message", "source_slice_text"]);
  const fields = Object.entries(record).filter(([key, value]) => value != null && value !== "" && !hidden.has(key) && typeof value !== "object");

  return (
    <main className="min-h-[calc(100dvh-44px)] w-full bg-background px-5 py-8 text-text-primary sm:px-8 lg:px-12">
      <div className="mx-auto max-w-6xl">
        <Link href="/inbox" className="text-xs text-text-muted hover:text-accent">← Market Inbox</Link>
        <div className="mt-5 border-b border-border-subtle pb-5">
          <div className="text-[10px] font-bold uppercase tracking-[0.2em] text-accent">{label(params.kind)}</div>
          <h1 className="mt-2 text-2xl font-semibold">{title}</h1>
          <div className="mt-2 text-xs text-text-muted">Record #{params.id} · {schema}</div>
        </div>
        <div className="grid gap-8 py-7 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.7fr)]">
          <section>
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">Parsed fields</h2>
            <div className="mt-3 grid gap-x-8 sm:grid-cols-2">
              {fields.map(([key, value]) => <div key={key} className="flex justify-between gap-4 border-b border-border-subtle py-3 text-sm"><span className="text-text-muted">{label(key)}</span><span className="text-right text-text-primary">{String(value)}</span></div>)}
            </div>
          </section>
          <aside>
            <h2 className="text-[10px] font-bold uppercase tracking-[0.2em] text-text-muted">Original source</h2>
            <div className="mt-3 whitespace-pre-wrap border-l border-accent/40 pl-4 text-sm leading-7 text-text-secondary">{source || "Source text unavailable"}</div>
          </aside>
        </div>
      </div>
    </main>
  );
}
