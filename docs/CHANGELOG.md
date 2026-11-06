# PropAI MCP changelog

## 2026-11-06 — Source-backed tenant search

- Added atomic WhatsApp broadcast parsing with building, locality, BHK, carpet area, floor, furnishing, parking, rent/sale, deposit, brokerage, pets, restrictions, possession, broker, source, and confidence fields.
- Added Indian rent normalization for lakh/lac/L, k/thousand, comma-formatted rupees, ranges, and the common small-`K` rental typo.
- Added conservative repost clustering with first/last seen, repost count, source groups/messages, broker aggregation, rent ranges, and revised-quote handling.
- Added Bandra West micro-market and building aliases plus explicit Bandra/Khar ambiguity flags.
- Structured MCP search and market summaries now fall back to tenant-scoped, group-captured raw messages when typed listings are absent; raw text remains unverified evidence.
- Added filters for INR budgets, furnishing, parking, pets, community restrictions, deal type, freshness, transaction type, and sort/offset pagination.
- Raw search now defaults to groups, accepts the inclusive 90-calendar-day boundary, exposes `next_cursor`, and adds `raw_message_get` for complete source text.
- Kept `search_listings` and `listing_contactBroker` as backward-compatible aliases.
- Added Account → MCP at `https://app.propai.live/account?tab=mcp`, showing the Claude/MCP server URL `https://mcp.propai.live/mcp`.

No historical WhatsApp messages were backfilled and no fields are invented when the source does not contain them.
