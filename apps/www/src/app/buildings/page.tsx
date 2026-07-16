import Link from "next/link";
import { ArrowRight, MapPin, Building2 } from "lucide-react";
import { getAllBuildings } from "@/lib/localities";

export const metadata = {
  title: "Buildings — PropAI",
  description:
    "Browse buildings tracked by PropAI, with listing counts from WhatsApp broker networks.",
};

export default async function BuildingsIndexPage() {
  const buildings = await getAllBuildings();

  return (
    <div className="min-h-screen bg-black text-white">
      <main className="max-w-7xl mx-auto px-4 lg:px-6 py-10 lg:py-14">
        <Link
          href="/"
          className="inline-flex items-center gap-2 text-sm text-zinc-400 hover:text-white transition-colors mb-8"
        >
          <span aria-hidden="true">←</span> Back to home
        </Link>

        <header className="mb-10">
          <h1 className="text-[32px] lg:text-[44px] leading-[1.1] font-bold text-white mb-3">
            Buildings
          </h1>
          <p className="text-lg text-zinc-400 max-w-2xl">
            {buildings.length} buildings tracked by PropAI, with live listing
            counts from broker conversations.
          </p>
        </header>

        {buildings.length === 0 ? (
          <p className="text-zinc-400">No buildings indexed yet.</p>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 lg:gap-6">
            {buildings.map((b) => (
              <div
                key={b.name}
                className="group bg-zinc-900/50 border border-white/10 rounded-xl p-5 lg:p-6 transition-colors hover:border-green-400/50 hover:bg-zinc-900"
              >
                <div className="flex flex-col h-full">
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <h3 className="text-lg font-semibold text-white group-hover:text-green-400 transition-colors">
                      {b.name}
                    </h3>
                    <span className="flex items-center gap-1 text-xs font-medium whitespace-nowrap">
                      {b.geocoded ? (
                        <span className="flex items-center gap-1 text-green-400">
                          <MapPin className="w-3.5 h-3.5" aria-hidden="true" />
                          Mapped
                        </span>
                      ) : (
                        <span className="flex items-center gap-1 text-zinc-500">
                          <Building2 className="w-3.5 h-3.5" aria-hidden="true" />
                          {b.listingCount} listings
                        </span>
                      )}
                    </span>
                  </div>
                  <p className="text-xs text-zinc-500 mt-auto">
                    {b.microMarket || "Locality pending"}
                    {b.listingCount > 0 ? ` · ${b.listingCount} listings` : ""}
                  </p>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="text-center mt-12">
          <Link
            href="/localities"
            className="inline-flex items-center gap-2 px-6 py-3 bg-green-400 text-black text-sm font-semibold rounded-lg hover:bg-green-300 transition-colors"
          >
            Browse by locality
            <ArrowRight className="w-4 h-4" aria-hidden="true" />
          </Link>
        </div>
      </main>
    </div>
  );
}
