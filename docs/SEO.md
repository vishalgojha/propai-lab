# SEO & Crawlability Contract

PropAI's public site (www.propai.live) must be crawlable by search engines and AI systems. This document defines the rules.

## Rendering

- All public pages are server-side rendered (Next.js App Router with `export const revalidate = 300`).
- No client-side-only content that crawlers can't see.
- Counters, lists, and data tables render real values in the initial HTML.
- `CountUp` components render the target value on the server; animation starts from 0 only on the client.

## Counters & statistics

- Never show "0" for counters that have real data.
- Never show placeholder values ("Updating", "Loading...", "N/A") on public pages.
- If data is unavailable, hide the counter entirely rather than showing a placeholder.
- All counters on the homepage are SSR-rendered with real values from the database.

## URLs

- Listing URLs use SEO-friendly slugs: `/listings/{bhk}-{locality}-{id}`.
- Bare numeric IDs redirect via 308 middleware to the slug form.
- Canonical slug mismatches redirect via 301 at the page level.
- All listing URLs are in the sitemap (up to 10,000, 90-day freshness window).
- Locality pages include sub-segments: `/localities/{slug}/sale`, `/rent`, `/commercial`, `/bhk-N`.
- Building pages: `/buildings/{slug}`.

## Sitemap

- Cap: 49,000 entries (under Google's 50k limit).
- Listings: last 90 days, priority 0.55, daily change frequency.
- Localities: priority 0.75, with sub-segments at 0.65-0.7.
- Buildings: priority 0.6, weekly change frequency.
- Static pages (about, contact): priority 0.6, monthly.

## Structured data

- Homepage: `Organization` + `WebSite` schema.
- Listing pages: `RealEstateListing` + `BreadcrumbList` schema.
- All listing URLs in structured data match the canonical slug URL.

## Internal linking

- Homepage → locality pages (top localities grid + browse-by-locality section).
- Locality pages → building pages → listing pages.
- Search results → listing pages via `ListingTile` component.
- Listing pages → related locality/building pages (cross-links).
- Breadcrumbs on all pages: Home → Locality → Building → Listing.

## Content quality

- No lorem ipsum, no "coming soon", no "updating" text visible to crawlers.
- Empty states use descriptive text ("No listings in this locality yet") not placeholders.
- All text content is real — no fake counts, no synthetic descriptions.

## Trust signals

- Every listing shows its source: "Sourced from WhatsApp broker network".
- Freshness indicator: "Last updated X days ago" per listing.
- Broker count, listing count, and locality count are real database values.
- The homepage explains the data pipeline: WhatsApp groups → parsing → structured listings.

## AI crawlers

- Meta tags and Open Graph tags on all pages.
- JSON-LD structured data for rich results.
- Clean HTML without JavaScript-dependent content.
- FAQ schema on relevant pages.
