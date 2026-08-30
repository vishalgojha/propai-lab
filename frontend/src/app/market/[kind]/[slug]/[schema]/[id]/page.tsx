"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import * as api from "@/lib/api";
import { Card } from "@/components/ui/card";

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

  if (invalidUrl || !schema) return <div className="market-record-page min-h-screen p-8 text-sm">Invalid market record URL</div>;
  if (error) return <div className="market-record-page min-h-screen p-8 text-sm">{error}</div>;
  if (!record) return <div className="market-record-page min-h-screen p-8 text-sm">Loading market record...</div>;

  const text = (value: unknown) => String(value ?? "").trim();
  const title = text(record.summary_title) || text(record.building_name) || text(record.micro_market) || `${label(params.kind)} #${params.id}`;
  const source = text(record.source_slice_text) || text(record.source_message);
  const hidden = new Set(["raw_payload", "ai_extraction", "contacts", "broker_phone", "sender_phone", "source_message", "source_slice_text"]);
  const fields = Object.entries(record).filter(([key, value]) => value != null && value !== "" && !hidden.has(key) && typeof value !== "object");

  return (
    <main className="market-record-page min-h-[calc(100dvh-44px)] w-full px-5 py-8 sm:px-8 lg:px-12">
      <div className="mx-auto max-w-6xl">
        <Link href="/inbox" className="market-record-back text-xs hover:underline">← Market Inbox</Link>
        <div className="mt-5 border-b border-border-subtle pb-5">
          <div className="market-record-kicker text-[10px] font-bold uppercase tracking-[0.2em]">{label(params.kind)}</div>
          <h1 className="market-record-title mt-2 text-2xl font-semibold">{title}</h1>
          <div className="market-record-muted mt-2 text-xs">Record #{params.id} · {schema}</div>
        </div>
        <div className="grid gap-8 py-7 lg:grid-cols-[minmax(0,1fr)_minmax(320px,0.7fr)]">
          <section>
            <Card className="market-record-card p-5">
              <h2 className="market-record-muted text-[10px] font-bold uppercase tracking-[0.2em]">Parsed fields</h2>
              <div className="mt-3 grid gap-x-8 sm:grid-cols-2">
                {fields.map(([key, value]) => <div key={key} className="market-record-row flex justify-between gap-4 border-b py-3 text-sm"><span className="market-record-muted">{label(key)}</span><span className="market-record-value text-right">{String(value)}</span></div>)}
              </div>
            </Card>
          </section>
          <aside>
            <Card className="market-record-card p-5">
              <h2 className="market-record-muted text-[10px] font-bold uppercase tracking-[0.2em]">Original source</h2>
              <div className="market-record-source mt-3 whitespace-pre-wrap border-l-2 pl-4 text-sm leading-7">{source || "Source text unavailable"}</div>
            </Card>
          </aside>
        </div>
      </div>
    </main>
  );
}
