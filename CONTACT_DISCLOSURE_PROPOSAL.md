# Contact numbers with matching options: preparation proposal

Status: local implementation candidate, not independently reviewed or deployed.
Base: fd9a07228f9f0c96bddffb76f0df85fbba162a1f.
User request: 23 Nov 2026 20:17 and 20:19 IST. Show numbers with results, without a separate flat-interest or contact-label question. Release approval still required.

## Existing promise

broker_market_policy.py CONSENT_TEXT, version broker-property-cross-search-v2, promises source owners that contacts are hidden until a broker chooses a specific option. routers/broker_market.py exposes that text through /policy and /raw-sources; set_raw_sources requires the exact version and explicit confirmation. The independent raw-sharing migration stores that version, confirmer and timestamp against the exact tenant/connection/group identity. Current search/option responses redact contacts; the selected-option contact endpoint returns one selected number with unverified ownership.

Do not rewrite that consent, reinterpret old grants, change old confirmation timestamps, or attach contacts globally.

## Minimal product decision

Approve preparing a new opt-in for source owners: they may allow supported phone numbers from their selected group posts to accompany matching property-search results for authenticated PropAI brokers. Existing sources remain on their current hidden-contact policy unless their owner agrees. This change is not permission to publish numbers to the web, export a contact directory, or add private chats.

Proposed owner-facing opt-in:

"Include the contact numbers written in future property posts from these selected groups alongside matching search results for authenticated PropAI brokers and their assistants. Results may contain several numbers; PropAI shows their nearby labels and does not verify ownership. Numbers may accompany a requested private property-shortlist Excel, but must not be published, exported as a general contact directory, or used for bulk outreach. Existing group-sharing and privacy controls still apply. You can turn this off at any time for future requests."

A separate unchecked confirmation is required. Do not combine it with extraction, reader access or old raw-sharing selection. Do not preselect existing sources.

## Minimal staged design

1. Keep existing raw-sharing v2 grants unchanged. Add a distinct versioned per-source contact-disclosure grant, exact organization/connection/broker/group identity, confirmer, grant timestamp, revocation timestamp and parent raw-grant confirmation timestamp.
2. A disclosure is allowed only while the exact parent raw grant is current and unrevoked, all existing source predicates pass, and the contact grant is current and unrevoked. Bind to the original parent grant instance so revoke/regrant does not resurrect contact permission. A source opt-out, connection replacement or raw-sharing revocation must disable disclosure immediately, including old option references.
3. Both source-post and capture timestamps must be at or after the contact-disclosure grant timestamp. This intentionally authorizes future posts only. It does not backfill disclosure for older posts; original raw-sharing forward-only dates are preserved as an additional boundary.
4. Return a per-result contact policy from authoritative search/get SQL. Never trust client flags, a global reader toggle, source display names, or signed option contents as sufficient permission. Re-read current permission on every option get/contact call. Missing/unknown grant data fails closed to masked output.
5. For newly authorized rows, retain contact-redacted message text and add a separate contacts array with every distinct supported in-post number plus its contact-redacted nearby label and explicit unverified-ownership basis. Do not arbitrarily choose a primary contact. Leave emails, links and unsupported identifiers redacted. Do not automatically attach sender_phone fallback: a poster may be unrelated to the advertised property, and that disclosure is not covered by the proposed in-post-number consent.
6. For legacy rows, preserve current masked search output and selected-option contact contract. For newly authorized rows, a compatibility contact operation may return the same labelled array without fabricated interest quotes, but only after current source eligibility is rechecked. Document dual behavior clearly. Do not relax the legacy gate globally.
7. REST and the /market/mcp adapter must call the same policy and response builder. Inspect actual deployed authenticated raw-MCP bridge separately before making parity claims. Anonymous/public APIs must not gain contacts. Add no contact-index query, bulk export, person search or new search scope.
8. Preserve reader authorization, property-query restrictions, limits, pagination, source hash and 30-minute reader-bound references, rates and no-store responses. Automatic contact arrays use normal bounded result pages, not a separate contact-harvesting path.
9. Publish revised contract guidance/revision and owner-facing consent explanation alongside the release. The frontend needs an explicit owner opt-in and visible on/off state; no grant is activated by deployment alone.

## Verification matrix before any release

- Old v2 source stays masked after deploy and after repeated raw-sharing confirmation.
- New grant exposes only supported in-post numbers on future source posts and capture times; old posts remain masked.
- Mixed old/new source page applies policy independently to each row.
- No grant, malformed grant, unknown version, storage error, expired/revoked source, wrong tenant/device/group or parent-grant mismatch cannot expose contacts.
- Uncheck, opt-out, connection replacement, raw revoke/regrant and contact revoke deny disclosure on previously issued option references.
- Two valid labelled in-post numbers both appear, repeated equivalent number is deduplicated, labels redact every phone/email/link, no arbitrary primary number or ownership claim.
- No in-text number means empty contacts, not implicit sender fallback.
- Legacy contact compatibility still requires genuine option interest and selected label; auto-granted contact compatibility needs no false confirmation fields.
- REST/MCP equivalence, anonymous denial, no public/client artifact exposure, no private-DM expansion.
- Idempotent opt-in preserves grant timestamp; disable then re-enable creates a new forward boundary.
- Actual migration and HTTP tests in disposable local PostgreSQL, followed by independent review and normal build validation.

## Release boundary

A local executable migration, API/REST-MCP changes, owner consent panel and guidance updates have been prepared. No migration has been applied outside disposable local tests. No pushes, grants, account changes, schema changes or deployments. A future implementation needs explicit release review covering API, permission migration and owner UI. Keep paused classification and admin candidates separate. Existing search and contact tests continue under the current live contract.

## Output extension requested 20:20 IST

The private search presentation should group only evidence-supported same-flat offers, with a separate source-backed broker/contact label, quoted rent, furnishing and post time per offer. Building name alone is never a same-flat identity key. Unknown/contradictory identity stays separate or explicitly uncertain. The API returns source messages, not verified flat entities; no new deterministic flat-merging implementation is proposed here. Preserve option/source references privately so contact arrays cannot be detached from the correct quote. Broker names are contextual source claims, not verified identities; the new contact grant should not add sender identity fields or unrelated private provenance. Public/client-facing artifacts continue to exclude broker contacts. The live rental worker owns actual dedupe and results.

## Completion review,23 Nov20:42 IST

A result is one whole source message. The candidate does not segment a digest into flats or establish contact ownership. It now exposes explicit source-post scope and unverified association with the nearby labels. Any ambiguous digest contacts must appear once, separately from per-flat brokers. This scope/product decision is pending user response via main.

Rate exposure: existing workspace rates are60 search calls/hour at max20 rows/page,60 option gets/hour and10 contact calls/hour. Up to1,200 post-contact sets/hour through search alone, with no bounded distinct-phone count per digest. No new limit/truncation has been invented. Source opt-in wording expressly discloses whole-post/unrelated-number behavior.

Rollout order is additive migration first, then API, then UI. Retain old RPCs for API rollback. Claims cover REST and /market/mcp only; no external raw-MCP bridge parity proved. Source opt-out revokes the parent grant and therefore the contact grant; resetting opt-out or regranting raw sharing never restores automatic contacts without a fresh contact grant.
