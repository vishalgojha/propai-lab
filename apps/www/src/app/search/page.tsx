import Link from "next/link";
import { Sparkles } from "lucide-react";
import { describeNaturalSearch, searchNaturalLanguageListings } from "@/lib/natural-search";
import { getAllLocalities } from "@/lib/localities";
import { slugify } from "@/lib/supabase";
import SearchBox from "@/components/SearchBox";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { ShortlistProvider } from "@/components/ShortlistProvider";
import ShortlistBar from "@/components/ShortlistBar";
import RequirementCapture from "@/components/RequirementCapture";
import SearchAiChat from "@/components/SearchAiChat";
import SearchResultsView from "@/components/SearchResultsView";
import { NOINDEX } from "@/lib/seo";

const MAPBOX_TOKEN =
  process.env.NEXT_PUBLIC_MAPBOX_TOKEN || process.env.MAPBOX_TOKEN || null;

// Locality/building lists change gradually; a few minutes of staleness is fine
// and avoids re-scanning the full tables on every navigation. ISR caches the
// rendered page for 5 min so link clicks feel instant.
export const revalidate = 300;

export const metadata = {
  title: "Search Listings — PropAI",
  description:
    "Search live WhatsApp broker listings in plain English. Try queries like '3 BHK in Bandra West budget 2 to 3 lakh'.",
  robots: NOINDEX,
  alternates: {
    canonical: "/search",
  },
};

type SearchParams = Promise<{ q?: string; asset?: string }>;

const ASSET_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "All" },
  { value: "residential", label: "Residential" },
  { value: "commercial", label: "Commercial" },
];

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const { q = "", asset: assetParam = "" } = await searchParams;
  const query = q.trim();
  const asset =
    assetParam === "residential" || assetParam === "commercial" ? assetParam : null;
  const state = query ? await searchNaturalLanguageListings(query, 24, asset) : null;
  const knownLocalities = await getAllLocalities();
  const summary = state?.parsed ? describeNaturalSearch(state.parsed) : "";

  // Compact, LLM-safe context describing the listings the user is currently
  // looking at, so the "Ask AI" follow-up chat can answer about them.
  const aiContext = state
    ? (() => {
        const lines: string[] = [];
        if (query) lines.push(`Search query: "${query}"`);
        if (asset) lines.push(`Asset type: ${asset}`);
        const rows = state.results.slice(0, 15);
        lines.push(`Showing ${state.results.length} result(s); listing up to ${rows.length} below:`);
        for (const r of rows) {
          const parts = [
            r.building_name || r.location_label || "Unknown location",
            r.bhk ? `${r.bhk} BHK` : null,
            r.priceLabel !== "Price on request" ? r.priceLabel : null,
            r.intent ? `(${r.intent})` : null,
            r.micro_market ? `@ ${r.micro_market}` : null,
            r.broker_name ? `broker: ${r.broker_name}` : null,
          ].filter(Boolean);
          lines.push("- " + parts.join(" "));
        }
        return lines.join("\n");
      })()
    : "";
  // Results render whenever a search/browse produced a state — including an
  // asset-only browse like /search?asset=commercial (no free-text query).
  const hasResults = Boolean(state);

   return (
    <div className="min-h-screen bg-black text-white">
      <SiteHeader />
      <ShortlistProvider>
      <main className="max-w-[1600px] mx-auto px-4 sm:px-8 xl:px-12 py-10 lg:py-14">
        <header className="max-w-5xl">
          <div className="inline-flex items-center gap-2 rounded-full border border-green-400/20 bg-green-400/10 px-3 py-1 text-xs font-medium text-green-300 mb-4">
            <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
            Natural-language search
          </div>
          <h1 className="text-[32px] lg:text-[48px] leading-[1.05] font-bold text-white max-w-3xl">
            Search live listings the way you actually ask for them.
          </h1>
          <p className="mt-4 text-[15px] lg:text-[18px] text-zinc-400 max-w-3xl">
            Describe the home you want, and PropAI will look across live broker listings, localities, and buildings.
          </p>

          <div className="mt-8 max-w-2xl">
            <SearchBox query={query} asset={assetParam} localities={knownLocalities} />
          </div>

          {!query && (
            <>
              <div className="mt-8 flex flex-wrap gap-2">
                {[
                  "3 BHK in Bandra West budget 2 to 3 lakh",
                  "2 BHK in Andheri West under 2 lakh",
                  "Fully furnished rental in Powai",
                  "Offices in BKC",
                ].map((example) => (
                  <Link
                    key={example}
                    href={`/search?q=${encodeURIComponent(example)}`}
                    className="rounded-full border border-white/10 bg-zinc-900/70 px-4 py-2 text-sm text-zinc-300 hover:border-green-400/40 hover:text-white transition-colors"
                  >
                    {example}
                  </Link>
                ))}
              </div>

              <div className="mt-8 rounded-2xl border border-white/10 bg-zinc-900/40 p-5 lg:p-6">
                <h2 className="text-sm font-semibold text-white mb-3">Search tips</h2>
                <ul className="grid gap-2 text-sm text-zinc-400 sm:grid-cols-2">
                  <li>• Type the way you&apos;d ask a broker — plain English works.</li>
                  <li>• Add a locality: &ldquo;in Bandra West&rdquo;, &ldquo;near Andheri&rdquo;.</li>
                  <li>• Set a budget: &ldquo;budget 2 to 3 lakh&rdquo; or &ldquo;under 2 lakh&rdquo;.</li>
                  <li>• Specify config: &ldquo;2 BHK&rdquo;, &ldquo;3 BHK furnished&rdquo;.</li>
                  <li>• Pick residential or commercial from the toggle above.</li>
                  <li>• Stuck? Try a building or society name directly.</li>
                </ul>
              </div>
            </>
          )}
        </header>

        {hasResults ? (
          <section className="mt-10 space-y-6">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              {query && (
                <>
                  <span className="text-zinc-500">Searching for:</span>
                  <span className="rounded-full border border-white/10 bg-zinc-900 px-3 py-1 text-zinc-200">{query}</span>
                </>
              )}
              {summary && (
                <span className="rounded-full border border-green-400/20 bg-green-400/10 px-3 py-1 text-green-200">
                  {summary}
                </span>
              )}
              {asset && (
                <span className="rounded-full border border-green-400/20 bg-green-400/10 px-3 py-1 text-green-200 capitalize">
                  {asset}
                </span>
              )}
              {!query && asset && (
                <span className="text-zinc-500">Showing {asset} listings</span>
              )}
            </div>

            {state && state.parsed.locality && (
              <div className="rounded-2xl border border-white/10 bg-zinc-950/80 p-4 text-sm text-zinc-400">
                We found matching results in{" "}
                <Link
                  href={`/localities/${slugify(state.parsed.locality)}`}
                  className="font-medium text-green-300 hover:text-green-200"
                >
                  {state.parsed.locality}
                </Link>
                .
              </div>
            )}

            {state && state.localityUnmatched && (
              <div className="rounded-2xl border border-amber-400/20 bg-amber-400/5 p-4 text-sm text-amber-200/90">
                We don&apos;t track{" "}
                <span className="font-medium text-amber-100">{state.parsed.statedLocalityText || "that locality"}</span>{" "}
                yet, so we can&apos;t show listings there. We only cover these localities right now:
                <div className="mt-3 flex flex-wrap gap-2">
                  {state.localitySuggestions.map((loc) => (
                    <Link
                      key={loc.slug}
                      href={`/localities/${loc.slug}`}
                      className="rounded-full border border-white/10 bg-zinc-900 px-3 py-1 text-xs text-zinc-200 hover:border-green-400/40 hover:text-white transition-colors"
                    >
                      {loc.locality}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            {state && state.results.length > 0 ? (
              <>
                <SearchResultsView
                  results={state.results}
                  mapToken={MAPBOX_TOKEN}
                  footerNote={(row) =>
                    row.matchedOn.length > 0
                      ? `Matched on: ${row.matchedOn.join(", ")}`
                      : null
                  }
                />
              </>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-[3fr_1fr] gap-6">
                <RequirementCapture query={query} />

                <aside className="rounded-3xl border border-white/10 bg-zinc-950/80 p-6 lg:p-8">
                  <h2 className="text-lg font-semibold text-white mb-3">What happens next</h2>
                  <p className="text-sm text-zinc-400">
                    We keep the request attached to your timeline and follow up when matching inventory appears.
                  </p>
                  <div className="mt-6 rounded-2xl border border-white/10 bg-black/70 p-4 text-sm text-zinc-400">
                    If a match lands inside your timeline, the requirement can be routed to a broker and/or sent back to you for follow-up.
                  </div>
                </aside>
              </div>
            )}
            {aiContext && state && state.results.length > 0 && (
              <div className="mt-10">
                <SearchAiChat context={aiContext} />
              </div>
            )}
          </section>
        ) : (
          <section className="mt-10 grid grid-cols-1 lg:grid-cols-3 gap-4 lg:gap-6">
            <div className="rounded-3xl border border-white/10 bg-zinc-950/80 p-6 lg:p-8 lg:col-span-2">
              <h2 className="text-xl font-semibold text-white mb-3">What you can ask for</h2>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-zinc-300">
                {[
                  "3 BHK in Bandra West budget 2 to 3 lakh",
                  "2 BHK rental in Powai fully furnished",
                  "Office in BKC under 5 crore",
                  "Listings near Andheri West with 2 bathrooms",
                ].map((example) => (
                  <div key={example} className="rounded-2xl border border-white/10 bg-black/70 px-4 py-3">
                    {example}
                  </div>
                ))}
              </div>
            </div>
            <div className="rounded-3xl border border-white/10 bg-zinc-950/80 p-6 lg:p-8">
              <h2 className="text-lg font-semibold text-white mb-3">Live coverage</h2>
              <p className="text-sm text-zinc-400">
                Search across the live WhatsApp inventory backing the public locality pages.
              </p>
              <div className="mt-5 text-sm text-zinc-500">
                {knownLocalities.length > 0 ? (
                  <>
                    <div>{knownLocalities.length.toLocaleString()} localities tracked</div>
                    <div className="mt-1">{knownLocalities.slice(0, 3).map((l) => l.locality).join(" • ")}</div>
                  </>
                ) : (
                  <div>Loading live localities...</div>
                )}
              </div>
            </div>
          </section>
        )}
      </main>
      <ShortlistBar />
      </ShortlistProvider>
      <SiteFooter />
    </div>
  );
}
