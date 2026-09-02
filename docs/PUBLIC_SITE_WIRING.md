# Public site wiring checkpoint

Updated 2 September 2026.

## Verified and wired

- The Manus public-site branch remains a visual prototype; its mock inventory is not used in production. Its marketplace composition is now wired into the live-data homepage: hero/search, live network pulse, counters, inventory, localities, process, trust, shortlist, and footer.
- The hero now also carries the Manus-style editorial pulse treatment, live brief note, and query suggestions; suggestions route into the existing typed search flow.
- The full homepage now follows the approved Manus composition across the editorial hero, live market card, snapshot row, listing cards, locality guide, process steps, trust section, and closing CTA. Imagery is sourced from the first eligible live listing photo; when none exists, the UI renders a neutral branded treatment rather than stock or fabricated property imagery.
- Production `www` reads live listings through the existing server-side Supabase data layer.
- Listing URLs use the live canonical `/listings/[slug]/[id]` route.
- Listing detail pages use live typed data, source-grounded public copy, live photos when available, similar listings, and the server-controlled `/api/contact-broker/[id]` WhatsApp handoff.
- Residential and commercial inventory continue to use the existing asset switch and typed listing routes.
- The public fallback copy no longer invents Mumbai when locality data is absent. It now stays market/country agnostic for future cities.
- The public light theme is loaded after legacy compatibility CSS so the client-facing site does not inherit the internal app's dark palette.
- Super Admin observability uses the service-role-only bounded RPC. The wrapper migration was applied to Supabase on this checkpoint and returned a live snapshot successfully.

## Deliberately not added

- No mock listings, city-specific hardcoded selector, phone numbers, raw SQL console, or unrestricted agent database access.
- No automatic listing merge based only on a shared building name.

## Deployment notes

- Redeploy Coolify application `propai-lab:main` from the homepage wiring commit recorded with this checkpoint.
- The homepage query remains server-side and uses live Supabase data; an empty/error response renders an honest empty state rather than mock inventory.
- The Supabase observability migration is already live; no API code redeploy is required for that migration itself. If the API image is separately rebuilt, use the normal `api` deployment.
- The current Supabase advisor warning is unrelated to this wiring: `pg_net` is installed in `public` and should be moved only as a separately reviewed migration.
