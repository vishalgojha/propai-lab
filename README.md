# PropAI Public Site Redesign — Review Prototype

This repository contains an isolated static React prototype for the PropAI public-site redesign. It is intended for visual and interaction review before any production integration. The prototype uses a reusable marketplace structure that can switch between active cities and asset classes, while showing Mumbai as the current launch-market example.

> **Production boundary:** This prototype does not modify production app code, production routing, production data fetching, production SEO logic, database schemas, broker integrations, or backend logic. The listing records in `client/src/lib/listingData.ts` are explicitly shaped as mock API responses so the approved presentation can later be wired into the existing live data layer without changing the design vocabulary.

## Review branch

The intended review branch is `design/public-site-redesign`. The project is kept separate from `apps/www` and should be reviewed as a design handoff rather than merged directly into production.

## Included surfaces

| Surface | Purpose | Representative route |
| --- | --- | --- |
| Homepage marketplace | City selector, All / Residential / Commercial switcher, plain-English search, fresh inventory, localities, process, trust, and final CTA | `/` |
| Residential detail | BHK, carpet area, furnishing, OC, Jodi, freshness, source note, and broker handoff | `/listings/3-bhk-for-sale-30627/30627` |
| Commercial detail | Asset type, use case, area, fit-out, frontage / parking, OC, freshness, and broker handoff | `/listings/office-space-for-sale-bkc-4101/4101` |
| Additional commercial detail | Commercial rent state and Pune example for future-city validation | `/listings/retail-rent-baner-6202/6202` |

## Responsive behavior

The desktop layout uses an asymmetric editorial hero, with search and market controls on the left and a compact live-network snapshot on the right. Listing cards use a fixed internal rhythm, and locality cards resolve into a two-column browse pattern. The listing-detail view uses a two-column reading layout with the main property record on the left and a persistent broker handoff card on the right.

At mobile widths, the header collapses to a menu button, the hero stacks the market selector and network snapshot below the search, asset-class controls remain horizontally accessible, listing cards become a single column, locality cards become a single-column browse list, and the detail-page enquiry action becomes full-width. The three-step process also becomes a vertical sequence so it remains scannable without oversized dark panels or unnecessary blank space.

## Component behavior

The city selector currently switches between Mumbai, Bengaluru, and Pune records. The All / Residential / Commercial switcher filters the current market's listing records without changing the page structure. Suggested searches update from the active locality and asset class. Search submission confirms the user's brief with a toast in the prototype; the production handoff should replace that confirmation with the existing search route and live query behavior.

Listing cards retain the existing listing URL examples where available. Internal detail routes use the same `/listings/:slug/:id` pattern and select a shared detail layout from a typed record. Residential and commercial records differ in their specifications and broker-note language, but intentionally share the same visual components so the design can scale to new asset types and future cities.

The “Continue on WhatsApp” action is a review interaction that confirms the intended handoff. It does not contain a fabricated broker number or send a production message. The production implementation should connect this button to the existing broker routing and WhatsApp integration.

## Visual system

The chosen direction is **Mumbai Editorial Utility**: warm paper-white surfaces, strong ink contrast, signal green for live and verified states, restrained saffron freshness cues, DM Sans for interface copy, and Newsreader for editorial headings. The system deliberately avoids dark listing cards, generic uppercase titles, fake testimonials, anonymous lead forms, and city-specific layout assumptions.

## Local development

Install dependencies with `pnpm install`, then run `pnpm dev`. Type safety and production build checks are available through `pnpm check` and `pnpm build`.

## Recommended integration sequence

Review the homepage and representative residential and commercial details first. After visual approval, replace the mock record module with the existing live data adapter, preserve the production route and SEO contracts, then connect the enquiry buttons to the current WhatsApp broker-routing logic. Keep the reusable city and asset-class dimensions in the API response rather than hardcoding them into layout components.
