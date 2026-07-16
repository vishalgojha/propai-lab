import Link from "next/link";
import { ArrowRight, MapPin, MessageSquare, Search, Sparkles } from "lucide-react";
import { describeNaturalSearch, searchNaturalLanguageListings } from "@/lib/natural-search";
import { getAllLocalities } from "@/lib/localities";
import { slugify } from "@/lib/supabase";
import { toListingCardViewModel } from "@/lib/listing-card";
import RequirementCapture from "@/components/RequirementCapture";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Search Listings — PropAI",
  description:
    "Search live WhatsApp broker listings in plain English. Try queries like '3 BHK in Bandra West budget 2 to 3 lakh'.",
  alternates: {
    canonical: "/search",
  },
};

type SearchParams = Promise<{ q?: string }>;

function SearchForm({ query }: { query: string }) {
  return (
    <form action="/search" method="get" className="w-full">
      <div className="relative rounded-[28px] border border-white/10 bg-zinc-950/90 p-4 lg:p-5 shadow-[0_25px_80px_rgba(0,0,0,0.45)]">
        <div className="absolute inset-0 rounded-[28px] bg-gradient-to-br from-green-400/10 via-transparent to-transparent pointer-events-none" />
        <label htmlFor="natural-search" className="block text-sm font-medium text-zinc-400 mb-3">
          Search in plain English
        </label>
        <div className="relative">
          <Search className="absolute left-5 top-1/2 -translate-y-1/2 h-5 w-5 text-zinc-500" aria-hidden="true" />
          <input
            id="natural-search"
            name="q"
            type="search"
            defaultValue={query}
            placeholder="e.g. 3 BHK in Bandra West budget 2 to 3 lakh"
            className="w-full rounded-2xl border border-white/10 bg-black/80 py-5 pl-14 pr-28 text-[16px] lg:text-[18px] text-white placeholder:text-zinc-500 focus:border-green-400 focus:outline-none focus:ring-1 focus:ring-green-400"
            autoComplete="off"
          />
          <button
            type="submit"
            className="absolute right-3 top-1/2 -translate-y-1/2 inline-flex items-center gap-2 rounded-xl bg-green-400 px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-green-300"
          >
            Search
            <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>
        <p className="mt-3 text-sm text-zinc-500">
          Try a locality, building, broker, BHK, or a full request like “3 BHK in Bandra West budget 2 to 3 lakh”.
        </p>
      </div>
    </form>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const { q = "" } = await searchParams;
  const query = q.trim();
  const state = query ? await searchNaturalLanguageListings(query) : null;
  const knownLocalities = await getAllLocalities();
  const summary = state?.parsed ? describeNaturalSearch(state.parsed) : "";

  return (
    <div className="min-h-screen bg-black text-white">
      <main className="max-w-7xl mx-auto px-4 lg:px-6 py-10 lg:py-14">
        <div className="mb-8 flex items-center justify-between gap-4">
          <Link href="/" className="text-sm text-zinc-400 hover:text-white transition-colors">
            <span aria-hidden="true">←</span> Back to home
          </Link>
          <Link href="/localities" className="text-sm text-zinc-400 hover:text-white transition-colors">
            Browse localities
          </Link>
        </div>

        <header className="max-w-4xl">
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

          <div className="mt-8 max-w-4xl">
            <SearchForm query={query} />
          </div>

          {!query && (
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
          )}
        </header>

        {query ? (
          <section className="mt-10 space-y-6">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-zinc-500">Searching for:</span>
              <span className="rounded-full border border-white/10 bg-zinc-900 px-3 py-1 text-zinc-200">{query}</span>
              {summary && (
                <span className="rounded-full border border-green-400/20 bg-green-400/10 px-3 py-1 text-green-200">
                  {summary}
                </span>
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
                <span className="font-medium text-amber-100">{state.parsed.query.replace(/\bbhk\b.*/i, "").trim() || "that locality"}</span>{" "}
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
                <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 lg:gap-6">
                  {state.results.map((row) => {
                    const card = toListingCardViewModel(row, row.resultType === "building");
                    return (
                    <article
                      key={row.id}
                      className="group flex flex-col rounded-2xl border border-white/10 bg-zinc-950/90 p-5 transition-colors hover:border-green-400/40 hover:bg-zinc-900/90"
                    >
                      <div className="flex items-start justify-between gap-3 mb-3">
                        <div className="min-w-0">
                          <h2 className="text-lg font-semibold text-white group-hover:text-green-300 transition-colors truncate">
                            {card.title}
                          </h2>
                          {card.locality && (
                            <Link
                              href={`/localities/${card.localitySlug}`}
                              className="mt-1 inline-flex items-center gap-1 rounded-full border border-white/10 px-2.5 py-1 text-[11px] text-zinc-400 hover:border-green-400/30 hover:text-green-200 transition-colors"
                            >
                              <MapPin className="h-3.5 w-3.5" aria-hidden="true" />
                              {card.locality}
                            </Link>
                          )}
                        </div>
                        <span
                          className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-medium ${
                            card.statusTone === "available"
                              ? "border border-green-400/20 bg-green-400/10 text-green-300"
                              : "border border-amber-400/20 bg-amber-400/10 text-amber-200"
                          }`}
                        >
                          {card.statusLabel}
                        </span>
                      </div>

                      <div className="mb-4 flex items-baseline gap-2">
                        <span className="text-xl font-semibold text-white">{card.priceLabel}</span>
                      </div>

                      {card.specRow && (
                        <div className="mb-4 text-sm text-zinc-400">{card.specRow}</div>
                      )}

                      <div className="mt-auto space-y-2 text-sm text-zinc-400">
                        <p className="break-words">
                          <span className="text-zinc-500">Broker:</span>{" "}
                          {card.brokerName || "Verified network"}
                        </p>
                        <p>
                          <span className="text-zinc-500">Updated:</span>{" "}
                          {card.updatedLabel}
                        </p>
                        {row.matchedOn.length > 0 && (
                          <p>
                            <span className="text-zinc-500">Matched on:</span>{" "}
                            {row.matchedOn.join(", ")}
                          </p>
                        )}
                      </div>

                      {card.waLink ? (
                        <a
                          href={card.waLink}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl bg-green-400 px-4 py-2.5 text-sm font-semibold text-black transition-colors hover:bg-green-300"
                        >
                          <MessageSquare className="h-4 w-4" aria-hidden="true" />
                          Contact Broker
                        </a>
                      ) : (
                        <span className="mt-4 inline-flex items-center justify-center gap-2 rounded-xl border border-white/10 px-4 py-2.5 text-sm text-zinc-500">
                          <MessageSquare className="h-4 w-4" aria-hidden="true" />
                          Broker contact soon
                        </span>
                      )}
                    </article>
                    );
                  })}
                </div>
              </>
            ) : (
              <div className="grid grid-cols-1 lg:grid-cols-[2fr_1fr] gap-6">
                <RequirementCapture query={query} />

                <aside className="rounded-3xl border border-white/10 bg-zinc-950/80 p-6 lg:p-8">
                  <h2 className="text-lg font-semibold text-white mb-3">What happens next</h2>
                  <p className="text-sm text-zinc-400">
                    We keep the request attached to your timeline and follow up when matching inventory appears.
                  </p>
                  <div className="mt-5 flex flex-col gap-2">
                    <Link
                      href="/localities"
                      className="inline-flex items-center justify-between rounded-2xl border border-white/10 bg-zinc-900/80 px-4 py-3 text-sm text-zinc-200 hover:border-green-400/40 transition-colors"
                    >
                      Browse all localities
                      <ArrowRight className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                    </Link>
                    <Link
                      href="/buildings"
                      className="inline-flex items-center justify-between rounded-2xl border border-white/10 bg-zinc-900/80 px-4 py-3 text-sm text-zinc-200 hover:border-green-400/40 transition-colors"
                      >
                      Browse buildings
                      <ArrowRight className="h-4 w-4 text-zinc-500" aria-hidden="true" />
                    </Link>
                  </div>
                  <div className="mt-6 rounded-2xl border border-white/10 bg-black/70 p-4 text-sm text-zinc-400">
                    If a match lands inside your timeline, the requirement can be routed to a broker and/or sent back to you for follow-up.
                  </div>
                </aside>
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
    </div>
  );
}
