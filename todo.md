# PropAI mockup revision checklist

- [x] Replace Mumbai-only labels with city-agnostic marketplace copy.
- [x] Keep Mumbai as the current active-market example only.
- [x] Add explicit residential and commercial rent/sale support in the asset switcher and listing metadata.
- [x] Replace hardcoded city/locality presentation with database-shaped data structures that can be swapped for live records later.
- [x] Add dynamic examples for Mumbai, Bengaluru, and Pune without hardcoding them into the layout.
- [x] Preserve existing listing URL examples and search interaction structure.
- [x] Re-run desktop and mobile visual verification after the revision.
- [ ] Save one final checkpoint and deliver the mockup with preview attachments.

## Internal listing pages

- [ ] Define a shared listing-detail data model for residential and commercial properties.
- [ ] Add reusable listing-detail routes using the existing listing URL patterns.
- [ ] Build residential detail content with BHK, carpet area, furnishing, OC, Jodi, freshness, and broker handoff details.
- [ ] Build commercial detail content with asset type, use case, area, fit-out, frontage/parking, OC, and broker handoff details.
- [ ] Add responsive desktop and mobile layouts for detail pages.
- [ ] Add WhatsApp enquiry and broker contact interactions without fake reviews or testimonials.
- [ ] Verify representative residential and commercial listing URLs, then save a new checkpoint.

## Git review package

- [ ] Add a short README describing the static prototype, responsive states, component behavior, and production isolation boundary.
- [ ] Record the intended branch name as `design/public-site-redesign`.
- [ ] Capture homepage and residential/commercial listing-detail screenshots for visual reference.
- [ ] Confirm the package does not modify production backend, data fetching, routing, or SEO behavior.
- [ ] Save a new review checkpoint and deliver the package reference.
