import Link from "next/link";
import { ArrowRight, MapPin, Building2 } from "lucide-react";
import { getAllBuildings } from "@/lib/localities";

export const metadata = {
  title: "About PropAI — Verified Brokers, Fresh Listings",
  description:
    "PropAI reads WhatsApp broker groups to surface real, fresh property listings — and a direct line to the broker.",
};

export default async function AboutPage() {
  const buildings = await getAllBuildings(6);
  const geocodedCount = buildings.filter((b) => b.geocoded).length;

  return (
    <div className="min-h-screen bg-black text-white">
      <main className="max-w-3xl mx-auto px-4 lg:px-6 py-10 lg:py-16">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors mb-8"
        >
          <span aria-hidden="true">←</span> Back to home
        </Link>

        <h1 className="text-[32px] lg:text-[44px] leading-[1.1] font-bold text-white mb-6">
          About <span className="text-green-400">PropAI</span>
        </h1>

        <div className="space-y-6 text-[15px] lg:text-[17px] text-zinc-400 leading-relaxed">
          <p>
            PropAI reads WhatsApp broker groups so you get real, fresh listings —
            and a direct line to the broker who actually has the inventory.
          </p>
          <p id="freshness">
            Listings update daily from live conversations. Stale data is
            auto-hidden after 30 days, so what you see is what&apos;s actually
            on the market right now.
          </p>
          <p>
            Every enquiry goes straight to a real broker on WhatsApp. No chatbots,
            no forms, no spam — just a direct conversation with someone who can
            show you the home.
          </p>
          {buildings.length > 0 && (
            <p>
              Today we track {buildings.length} buildings
              {geocodedCount > 0 ? ` (${geocodedCount} geocoded)` : ""} and counting,
              sourced entirely from broker activity.
            </p>
          )}
        </div>

        <div className="mt-12 grid grid-cols-1 sm:grid-cols-2 gap-4">
          {buildings.length > 0 &&
            buildings.map((b) => (
              <div
                key={b.name}
                className="flex items-center justify-between gap-2 bg-zinc-900/50 border border-white/10 rounded-xl p-4"
              >
                <span className="flex items-center gap-2 text-white">
                  {b.geocoded ? (
                    <MapPin className="w-4 h-4 text-green-400" aria-hidden="true" />
                  ) : (
                    <Building2 className="w-4 h-4 text-zinc-500" aria-hidden="true" />
                  )}
                  {b.name}
                </span>
                <span className="text-xs text-zinc-500">{b.microMarket ?? "—"}</span>
              </div>
            ))}
        </div>

        <div className="mt-12">
          <Link
            href="/localities"
            className="inline-flex items-center gap-2 px-6 py-3 bg-green-400 text-black text-sm font-semibold rounded-lg hover:bg-green-300 transition-colors"
          >
            Browse localities
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Link>
        </div>
      </main>
    </div>
  );
}
