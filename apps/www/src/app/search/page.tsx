import { searchNaturalLanguageListings } from "@/lib/natural-search";
import { getAllLocalities } from "@/lib/localities";
import SiteHeader from "@/components/SiteHeader";
import SiteFooter from "@/components/SiteFooter";
import { ShortlistProvider } from "@/components/ShortlistProvider";
import ShortlistBar from "@/components/ShortlistBar";
import SearchResultsView from "@/components/SearchResultsView";
import { NOINDEX } from "@/lib/seo";

const GOOGLE_MAPS_API_KEY =
  process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ||
  process.env.GOOGLE_MAPS_API_KEY ||
  null;

export const revalidate = 300;
export const dynamic = "force-dynamic";

export const metadata = {
  title: "Search Listings — PropAI",
  description:
    "Search PropAI listings through an assistant. Connect an assistant to PropAI, then ask for properties in plain language.",
  robots: NOINDEX,
  alternates: {
    canonical: "/search",
  },
};

type SearchParams = Promise<{ q?: string; asset?: string }>;

async function getSearchLocalities() {
  try {
    return await Promise.race([
      getAllLocalities(),
      new Promise<Awaited<ReturnType<typeof getAllLocalities>>>((_, reject) =>
        setTimeout(() => reject(new Error("Locality lookup timed out")), 8000),
      ),
    ]);
  } catch (err) {
    console.error("getAllLocalities failed:", err);
    return [] as Awaited<ReturnType<typeof getAllLocalities>>;
  }
}

function HowToSearchPanel() {
  return (
    <section className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-5 lg:p-6">
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">How to search</h2>
      <ol className="mt-3 list-decimal space-y-2 pl-5 text-sm text-[var(--text-secondary)]">
        <li>Connect an assistant to PropAI.</li>
        <li>Ask for properties in plain language (for example, locality, budget, BHK, or property type).</li>
      </ol>
      <div className="mt-4 space-y-2 text-sm text-[var(--text-secondary)]">
        <p>
          For Instinct, say{" "}
          <span className="font-medium text-[var(--text-primary)]">&ldquo;Connect me to PropAI&rdquo;</span>.
        </p>
        <p>
          For compatible MCP clients, use{" "}
          <code className="rounded bg-black/10 px-1.5 py-0.5 text-[var(--text-primary)]">
            https://mcp.propai.live/mcp
          </code>
          .
        </p>
        <p>
          Matching listings can be returned as links, without broker phone numbers. Searches can currently return no
          results.
        </p>
      </div>
    </section>
  );
}

export default async function SearchPage({ searchParams }: { searchParams: SearchParams }) {
  const { q = "", asset: assetParam = "" } = await searchParams;
  const query = q.trim();
  const asset =
    assetParam === "residential" || assetParam === "commercial" ? assetParam : null;

  let state: Awaited<ReturnType<typeof searchNaturalLanguageListings>> | null = null;
  let searchError = false;
  if (query) {
    const knownLocalities = await getSearchLocalities();
    try {
      state = await searchNaturalLanguageListings(query, 24, asset, knownLocalities);
    } catch (err) {
      console.error("searchNaturalLanguageListings failed:", err);
      searchError = true;
    }
  }

  const hasListingResults = Boolean(state && state.results.length > 0);

  return (
    <div className="www-shell min-h-screen">
      <SiteHeader />
      <ShortlistProvider>
        <main className="www-page-main www-search-page mx-auto max-w-[1600px] px-4 py-6 sm:px-8 lg:py-12 xl:px-12">
          <header className="max-w-4xl">
            <h1 className="text-[28px] font-bold leading-[1.08] text-[var(--text-primary)] sm:text-[34px] lg:text-[48px]">
              Search through an assistant
            </h1>
            <p className="mt-4 max-w-3xl text-[15px] text-[var(--text-secondary)] lg:text-[18px]">
              PropAI is assistant-led. Use your assistant to ask for properties in plain language.
            </p>
            <div className="mt-8">
              <HowToSearchPanel />
            </div>
          </header>

          {query ? (
            <section className="mt-10 space-y-6">
              {searchError ? (
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 lg:p-8">
                  <h2 className="text-lg font-semibold text-[var(--text-primary)]">No matching listings right now</h2>
                  <p className="mt-2 text-sm text-[var(--text-secondary)]">
                    We couldn&apos;t load results for this search right now. Searches can currently return no results.
                  </p>
                </div>
              ) : hasListingResults && state ? (
                <SearchResultsView results={state.results} googleMapsApiKey={GOOGLE_MAPS_API_KEY} />
              ) : (
                <div className="rounded-2xl border border-[var(--border-subtle)] bg-[var(--bg-surface)] p-6 lg:p-8">
                  <h2 className="text-lg font-semibold text-[var(--text-primary)]">No matching listings right now</h2>
                  <p className="mt-2 text-sm text-[var(--text-secondary)]">
                    Searches can currently return no results. Matching listings, when available, can be returned as links
                    without broker phone numbers.
                  </p>
                </div>
              )}
            </section>
          ) : null}
        </main>
        <ShortlistBar />
      </ShortlistProvider>
      <SiteFooter />
    </div>
  );
}
