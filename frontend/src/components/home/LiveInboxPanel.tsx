"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowRight, Sparkles } from "lucide-react";

interface DemoListing {
  bhk: string;
  locality: string;
  price: string;
  detail: string;
  intent: string;
}

const DEMO_MESSAGES = [
  {
    key: "msg1",
    group: "South Mumbai Deals",
    sender: "Rajesh B.",
    preview: "3 BHK Bandra West 3L\n4 BHK Lokhandwala 3.8L\n4 BHK Khar West 3.5L\nAll LL\nPKG semi furnished\nBrand new bldg\n14th Road",
    listings: [
      { bhk: "3 BHK", locality: "Bandra West", price: "₹3L", detail: "LL · Semi furnished · PKG · New bldg · 14th Road", intent: "Lease" },
      { bhk: "4 BHK", locality: "Lokhandwala", price: "₹3.8L", detail: "LL · Semi furnished · PKG · Brand new bldg", intent: "Lease" },
      { bhk: "4 BHK", locality: "Khar West", price: "₹3.5L", detail: "LL · Semi furnished · PKG · New bldg", intent: "Lease" },
    ],
  },
  {
    key: "msg2",
    group: "Commercial Deals Mumbai",
    sender: "Imran S.",
    preview: "Office 2500 sqft carpet\nPowai Hiranandani\n5 cabins + open area\nPantry · 2 washrooms\n₹95/sqft\nLL negotiable\nImmediate possession",
    listings: [
      { bhk: "Office", locality: "Powai", price: "₹95/sqft", detail: "2500 sqft carpet · 5 cabins · Pantry · 2 washrooms · LL · Immediate", intent: "Lease" },
    ],
  },
  {
    key: "msg3",
    group: "Thane Property Network",
    sender: "Sanjay M.",
    preview: "1 BHK Thane West 65L\nReady possession\n550 sqft carpet\n8th floor\nGated society pool gym\nImmediate registry",
    listings: [
      { bhk: "1 BHK", locality: "Thane West", price: "₹65L", detail: "550 sqft carpet · 8th floor · Gated · Pool & Gym · Registry ready", intent: "Sale" },
    ],
  },
  {
    key: "msg4",
    group: "Industrial & Logistics",
    sender: "Prakash K.",
    preview: "Commercial Space / Retail Shop / Industrial Gala / Office\nAll at Bhiwandi\nSize from 800-5000 sqft\nRate ₹15-25/sqft\nLL available",
    listings: [
      { bhk: "Commercial", locality: "Bhiwandi", price: "₹15/sqft", detail: "800-1500 sqft · LL available", intent: "Lease" },
      { bhk: "Retail Shop", locality: "Bhiwandi", price: "₹18/sqft", detail: "1200 sqft · High footfall · LL available", intent: "Lease" },
      { bhk: "Industrial Gala", locality: "Bhiwandi", price: "₹25/sqft", detail: "5000 sqft · 22ft height · 3-phase power", intent: "Lease" },
      { bhk: "Office", locality: "Bhiwandi", price: "₹20/sqft", detail: "2000 sqft · 5 cabins · Pantry", intent: "Lease" },
    ],
  },
  {
    key: "msg5",
    group: "Requirement · Premium Clients",
    sender: "HDFC Team",
    preview: "URGENT REQUIREMENT\n1 BHK\nLocality: Mahim / Lower Parel / Worli\nBudget: 80-90k\nCorporate lawyer client\nImmediate possession\nFurnished preferred",
    listings: [
      { bhk: "1 BHK", locality: "Mahim / Parel / Worli", price: "₹80-90k", detail: "Corporate lawyer · Furnished preferred · Immediate", intent: "Requirement" },
    ],
  },
];

function intentBadge(intent: string) {
  const map: Record<string, string> = {
    Lease: "bg-emerald-500/20 text-emerald-300",
    Sale: "bg-blue-500/20 text-blue-300",
    Requirement: "bg-orange-500/20 text-orange-300",
  };
  const c = map[intent] || "bg-zinc-500/20 text-zinc-300";
  return <span className={`rounded px-1 py-0.5 text-[8px] font-semibold uppercase ${c}`}>{intent}</span>;
}

export function LiveInboxPanel() {
  const [selected, setSelected] = useState(DEMO_MESSAGES[0]);

  return (
    <section id="live-inbox" className="relative">
      <div className="relative overflow-hidden rounded-[28px] border border-white/10 shadow-[0_30px_90px_rgba(0,0,0,0.45)]">
        <div className="flex items-center justify-between border-b border-white/5 bg-black/80 px-3 py-2.5 sm:px-4">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 rounded-full bg-red-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-amber-400" />
            <span className="h-2.5 w-2.5 rounded-full bg-emerald-400" />
          </div>
          <div className="inline-flex items-center gap-1.5 rounded-full border border-white/5 bg-white/5 px-3 py-1 text-[10px] uppercase tracking-[0.24em] text-zinc-400">
            <Sparkles className="h-3 w-3" strokeWidth={1.8} />
            Real broker messages · what you&apos;ll see
          </div>
          <div className="w-20" />
        </div>

        <div className="grid gap-0 lg:grid-cols-[1fr_1fr]">
          <div className="border-b border-white/5 p-3 sm:p-4 lg:border-b-0 lg:border-r">
            <div className="mb-3 text-[10px] uppercase tracking-[0.28em] text-zinc-500">Latest from your groups</div>
            <div className="space-y-2">
              {DEMO_MESSAGES.map((m) => (
                <button
                  key={m.key}
                  type="button"
                  onClick={() => setSelected(m)}
                  className={`w-full rounded-2xl border p-2.5 text-left transition-colors ${
                    m.key === selected.key
                      ? "border-blue-400/40 bg-blue-500/10"
                      : "border-white/5 hover:border-white/10"
                  }`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="text-xs font-semibold text-white">{m.sender}</div>
                      <div className="text-[10px] text-zinc-500">{m.group} · {m.listings.length} item{m.listings.length > 1 ? "s" : ""}</div>
                    </div>
                  </div>
                  <div className="mt-1 text-[11px] leading-4 text-zinc-400 line-clamp-2 whitespace-pre-wrap">{m.preview.slice(0, 100)}</div>
                </button>
              ))}
            </div>
          </div>

          <div className="p-3 sm:p-4">
            <div className="p-3 sm:p-4">
              <div className="flex items-center justify-between gap-2">
                <div className="text-[10px] uppercase tracking-[0.24em] text-zinc-500">{selected.group}</div>
                <span className="text-[10px] text-zinc-500">{selected.sender}</span>
              </div>

              <div className="mt-3 space-y-2">
                {selected.listings.map((l, i) => (
                  <div key={i} className="p-2.5 border-b border-white/[0.04] last:border-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-bold text-white">{l.bhk}</span>
                          {intentBadge(l.intent)}
                        </div>
                        <div className="text-xs text-zinc-300 font-medium mt-0.5">{l.locality}</div>
                      </div>
                      <div className="text-sm font-bold text-[#3EE88A]">{l.price}</div>
                    </div>
                    <div className="mt-1.5 text-[10px] text-zinc-500 leading-relaxed">{l.detail}</div>
                  </div>
                ))}
              </div>

              <div className="mt-3 p-2.5 border-t border-white/[0.04]">
                <div className="text-[10px] uppercase tracking-[0.15em] text-zinc-500 mb-1">Original message</div>
                <div className="text-[11px] leading-5 text-zinc-400 whitespace-pre-wrap">{selected.preview}</div>
              </div>

              <div className="mt-3 flex justify-end">
                <Link
                  href="/inbox"
                  className="inline-flex items-center gap-2 rounded-full bg-[#3EE88A] px-4 py-2 text-sm font-semibold text-black transition-transform hover:translate-y-[-1px]"
                >
                  Open inbox
                  <ArrowRight className="h-4 w-4" strokeWidth={2} />
                </Link>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}