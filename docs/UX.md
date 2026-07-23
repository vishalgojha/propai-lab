# UX Commandments

Rules for what the UI must and must never do. These apply to all public-facing pages (www.propai.live) and the internal dashboard (app.propai.live).

## Counters & numbers

1. **Never show "0" for counters that have real data.** If the database has 10,000 listings, the homepage must show 10,000 — not 0 while loading.

2. **Never show placeholder values.** No "Updating", "Loading...", "N/A", "—", or "Coming soon" on public pages. If data is unavailable, hide the element entirely.

3. **Never fake counters.** Hardcoded values, "estimated" counts, or "similar to" numbers are forbidden. Every number on the public site comes from a live database query.

4. **Show real values in HTML, animate on client.** The `CountUp` component renders the target value in the server-side HTML (for crawlers), then animates from 0 on the client (for users).

## Empty states

5. **Use descriptive empty states, not placeholders.** "No listings in Bandra West yet" is good. "No data available" is not.

6. **Explain why it's empty.** "No broker activity has been tracked for this building yet. Listings appear automatically as soon as brokers post in our WhatsApp network."

7. **Never show loading skeletons as final content.** Loading states (`loading.tsx`) are transition UI, not permanent content. They must not contain readable text that crawlers index.

## Data display

8. **Always show the source broker.** Every listing must show which broker posted it. "Sourced from WhatsApp broker network" on aggregate views.

9. **Always show freshness.** "Last updated 2 days ago" or "Active today" per listing. Stale data must be hidden, not displayed with a warning.

10. **Never show internal IDs to users.** Listing IDs, broker IDs, message UIDs — these are for debugging, not for the UI.

## Navigation

11. **Every page must have a breadcrumb.** Home → Locality → Building → Listing. This helps both users and crawlers.

12. **Every listing must link back to its locality and building.** Cross-linking builds the site graph for crawlers.

13. **Search results must link to listing detail pages.** Never show search results without clickable links to the full listing.

## Forms & actions

14. **"Enquire" goes to WhatsApp, not a form.** The enquiry flow opens WhatsApp with a pre-filled message. No intermediate forms.

15. **Never collect email or phone on the public site.** Contact happens through WhatsApp only. No sign-up walls.

## Error states

16. **Show real error messages, not generic ones.** "This listing couldn't load — it may have been removed" is better than "Something went wrong".

17. **Never show stack traces or technical errors to users.** Log them server-side, show a human-friendly message.

## Accessibility

18. **All images must have alt text.** Building photos, broker avatars, map markers — everything needs alt text.

19. **All interactive elements must be keyboard-navigable.** Search, filters, listing cards — all reachable via Tab.

20. **Color is never the only indicator.** Status badges have text labels alongside color.
