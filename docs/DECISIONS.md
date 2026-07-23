# Decision Log

Record significant technical and product decisions. Format: date, decision, context, outcome.

## 2026-07-22 — Removed deterministic AI chat responses

**Decision:** All AI chat replies come from the LLM. No canned/fallback responses.

**Context:** The conversational path had deterministic responses for greetings and common queries. This created inconsistency — some replies felt robotic while others were natural.

**Outcome:** LLM handles all messages. Empty or failed responses show an explicit error to the user ("AI chat failed: {error}") instead of silent fallback. More consistent, more honest.

## 2026-07-22 — Provider Health: one card per llm_providers row

**Decision:** Provider health page shows one card per database row, not per provider name.

**Context:** Multiple rows can share the same provider name (e.g., two Groq API keys). Each row is an independent credential with its own health status.

**Outcome:** Per-key outage tracking. A compromised key doesn't hide other keys' health.

## 2026-07-22 — AI Usage cost keyed by provider name, not model name

**Decision:** MODEL_PRICING dict uses provider names (e.g., "groq", "cerebras") as keys, not model names.

**Context:** Model names are configured via environment variables and change at deploy time. Provider names are stable identifiers in the database.

**Outcome:** Pricing calculations survive model upgrades without code changes.

## 2026-07-22 — Listing slug always includes ID

**Decision:** All listing slugs end with the numeric ID: `{bhk}-{locality}-{id}`.

**Context:** Without the ID, two listings in the same locality with the same BHK would produce identical slugs, causing conflicts.

**Outcome:** Every listing URL is unique. Slugs are under 80 characters. Deterministic from listing fields.

## 2026-07-22 — Middleware for legacy bare-ID redirects

**Decision:** `/listings/12345` redirects via Next.js middleware (308) to `/listings/12345/12345`, then the page component 301s to the canonical slug.

**Context:** Next.js 16 dynamic segments at the same URL-tree position must use the same slug name. Coexisting `/listings/[id]` and `/listings/[slug]` is impossible.

**Outcome:** Clean redirect chain. Bare IDs work. Canonical URLs are slug-based.

## 2026-07-22 — Remove image pipeline (for now)

**Decision:** No image download/storage pipeline. Listing pages don't show property photos.

**Context:** WhatsApp images are ephemeral (media URLs expire). Building a full image pipeline (download, store, serve) is a significant undertaking with unclear ROI at this stage.

**Outcome:** Simpler system. Listings show text data only. Photos can be added later without migration pain.

## 2026-07-21 — DPDP Act: phone numbers never in public HTML

**Decision:** Broker phone numbers are resolved server-side via `/api/contact-broker/[id]` redirect, never embedded in page HTML.

**Context:** India's DPDP Act 2023 requires consent for personal data display. Phone numbers in HTML are crawlable and indexable.

**Outcome:** Compliant. Phone numbers only appear after user-initiated action (click "Enquire").

## 2026-07-20 — Self-chat prefers fastest healthy provider

**Decision:** Self-chat model chain order: Cerebras > Gemini > Groq > default chain.

**Context:** Self-chat is for quick commands and casual conversation. Latency matters more than capability for most messages.

**Outcome:** Sub-second responses for common queries. Complex requests fall through to the full chain.

## 2026-07-18 — Rejected: auto-merge listings

**Decision:** Do not automatically merge listings that appear to be the same property.

**Context:** Two messages about "3 BHK in Lodha Sea View" from the same broker might be the same unit or different floors. Without floor/wing data, merging risks losing distinct inventory.

**Outcome:** Duplicate listings stay separate. Users see slight duplicates rather than missing inventory. Manual dedup is preferred over algorithmic merging.

## 2026-07-15 — Supabase over raw Postgres

**Decision:** Use Supabase (managed Postgres + REST API + auth) instead of self-hosted Postgres.

**Context:** Small team needs fast iteration. Supabase provides auth, storage, real-time, and a dashboard without building infrastructure.

**Outcome:** Faster development. Trade-off: vendor dependency and REST API overhead for complex queries (mitigated by `propai_query_sql` RPC).
