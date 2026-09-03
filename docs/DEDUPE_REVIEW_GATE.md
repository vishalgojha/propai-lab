# Cross-tenant dedupe and pre-LLM batching review gate

Status: **not approved for further implementation**

This gate is intentionally separate from the existing implementation status in
`docs/DEDUPE_IMPLEMENTATION_STATUS.md`. The repository already contains partial
protocol filtering, exact-copy reuse, claims, source-signature protection, and
batch orchestration. This document records what must be reviewed before those
paths are widened or changed.

## Evidence available now

- Unit and worker tests cover deterministic normalization, protocol events,
  empty/chatter/media skips, tenant-scoped cache lookup, shared-result
  bookkeeping, stale claim recovery, consent checks, and exact-copy batching.
- `docs/whatsapp-card-parser-corpus.md` describes the intended ZIP corpus, but
  the referenced `/home/vishal/Downloads/wadata/*.zip` files are not present in
  the current workspace or mounted download directory.
- No reviewed truth set currently proves production false-merge rate, missed
  duplicate rate, or real LLM cost savings.

## Rules to approve before implementation

1. Protocol/control payloads are retained as raw evidence and excluded before
   any model call. `messageContextInfo` alone is not a protocol event.
2. Empty, media-only, pure chatter, too-short, and no-property-signal rows are
   skipped only by deterministic rules and receive an auditable reason.
3. Exact-copy identity is based on normalized message content plus resolved
   sender identity for same-author repeats. Prices, dates, punctuation, and
   material edits remain significant.
4. Cross-tenant model-output reuse may use only an exact versioned content hash.
   It must never transfer tenant ownership, group membership, sender identity,
   phone/contact fields, source text, or evidence links.
5. Every raw observation remains independently persisted with its own tenant,
   group, sender, timestamp, and source evidence. Batching shares a model-call
   opportunity; it does not merge observations or typed listings.
6. A claim serializes payment for one exact body only. A missing claim/result
   must fail closed rather than start another concurrent model call.
7. Edited copies, changed prices/dates/floors, different senders, different
   groups, and same-looking but distinct units must be re-evaluated and must
   not be silently collapsed.
8. Repeated source signatures may suggest a team relationship only within the
   tenant and with repeated source-grounded evidence. They must not merge broker
   identities or authorize cross-tenant visibility.
9. False merges and missed duplicates are measured against human-reviewed
   labels, not inferred from cache hits or semantic similarity.
10. Cost savings are reported from observed extraction usage rows and explicit
    avoided-call counts; no provider price is invented.

## Required reviewed corpus labels

Each pair or exact-copy cluster needs: `case_id`, `tenant_id`, `group_id`,
`sender_id` (or a privacy-safe stable surrogate), timestamp, raw text hash,
normalization version, `expected_duplicate`, `reason`, and the expected action
(`skip_protocol`, `skip_pre_llm`, `reuse_same_author`, `reuse_cross_tenant`,
`extract_again`, or `review`). Labels must preserve the original raw evidence;
phone numbers must not be committed to the repository.

The minimum sample must include:

- identical listing reposted by one sender in multiple groups;
- identical text from two different senders;
- same text across two tenants;
- whitespace, case, forwarding-banner, emoji, and line-wrap variation;
- changed price, date, floor, wing, unit, or contact details;
- two distinct units in the same building;
- protocol events, media-only rows, chatter, and real listings carrying
  `messageContextInfo`;
- multi-listing broadcasts whose child slices share a header/signature;
- repeated agency signatures with separate broker phones/names;
- claim winner, concurrent loser, stale claim, missing-table, provider-failure,
  and pending-reconciliation cases.

## Approval condition

Do not add broader dedupe rules, semantic clustering, automatic identity merges,
or wider ingestion until the ZIP corpus (or an equivalent redacted export) is
available, the cases above are labeled, and a reviewer approves the resulting
edge-case table. After approval, add the redacted corpus and evaluator tests,
then implement only the approved rules.

