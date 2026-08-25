# PropAI Brand Guidelines

## Product identity

- **Name:** PropAI
- **App tagline:** Broker OS
- **One-liner:** A WhatsApp-first discovery and matching layer for real broker inventory — connecting property seekers with real brokers through the channel where Indian real estate actually operates.

PropAI is not a property portal, CRM, chatbot, or web-scraped data
aggregator. It does not accept paid listings or insert itself between a
property seeker and the broker.

WhatsApp is the source of truth. A listing or requirement enters PropAI only
when it can be traced to a real WhatsApp message from a broker.

## Product surfaces

| Surface | Job | Audience and boundary |
| --- | --- | --- |
| `www.propai.live` | Public discovery, locality/building pages, natural search, and direct broker contact | Buyer-facing; only fresh, source-safe inventory is shown publicly |
| `app.propai.live` | WhatsApp connections, Market Inbox, My Deals, Auto Matched, broker controls, campaigns, and administration | Broker workspace; tenant-scoped operational data and controls |

The internal workspace is an operating layer over captured evidence, not a
second inventory source. Public pages must never expose broker phone numbers
in HTML; contact details are resolved only after an intentional contact action.

## Positioning principles

- Lead with the live broker-group signal, not generic AI capability.
- Emphasize preserved source context and direct broker access.
- Describe observed, scoped data rather than making market-wide claims.
- Keep Auto Matched framed as a review suggestion, not a guarantee or deal
  closer.
- Never imply that PropAI has a complete census of a locality or market.

## Voice and tone

Write directly for Indian real-estate brokers. Be practical, grounded, and
clear. Avoid generic SaaS language, hype, and claims that cannot be supported
by captured evidence.

Prefer:

- “Fresh broker inventory from WhatsApp.”
- “12 requirements captured in the last 7 days.”
- “View the original WhatsApp message.”
- “Contact the broker directly.”

Avoid:

- “The smartest property AI.”
- “Complete market coverage.”
- “Guaranteed matches.”
- “Demand is high” without a documented method, scope, window, and sample.

## Visual language

### Palette

The public brand uses a forest-green and warm-cream system. The dark public
surface is green ink, not neutral black; cream is the primary reading color,
and muted green supports secondary text and structured metadata.

| Token | Hex | Use |
| --- | --- | --- |
| `--ink` | `#12211A` | Primary forest background and dark text on cream |
| `--ink-2` | `#1A2E22` | Secondary forest surface and panels |
| `--parchment` | `#F3EEE1` | Primary cream text and light reading surface |
| `--parchment-dim` | `#E9E2D0` | Light surface background |
| `--signal` | `#4FA678` | Primary action and live signal |
| `--signal-dim` | `#3E8F5F` | Deeper action green and compact controls |
| `--amber` | `#D89B3C` | Prices and live indicators |
| `--broker-grey` | `#93A399` | Muted and secondary elements |

Public dark-mode mappings use the same family: `#12211A` page background,
`#1A2E22` panels, `#F3EEE1` headlines, `#A5B5A9` supporting copy, and
`#4FA678` actions/highlights. Avoid neutral-black backgrounds and neon mint
accents on public pages.

Use semantic tokens such as `--accent-primary`, `--price-highlight`,
`--live-indicator`, `--bg-base`, and `--text-primary` in new work. Do not add
new neon-mint literals or Tailwind `emerald-*` styling.

Dark-green buttons use cream text for contrast and brand consistency. Use dark
text only on light-green buttons where contrast supports it.

### Typography

- **Inter:** UI, body, and display text.
- **Instrument Serif:** voice and editorial emphasis, especially selected
  headline accents.
- **IBM Plex Mono:** structured data, labels, metadata, timestamps, and status
  chips.

### Logo

The PropAI mark is a rounded square (`rx=16` on a 64×64 canvas), filled with
sage green `#6B8E63`, with a warm-white `#FAF7F0` angular lightning-bolt path.
It communicates speed and automation without making the product feel like an
opaque AI oracle.

The canonical asset is `propai-logo.svg`, currently present in the public
directories for `frontend/`, `apps/www/`, and `apps/mcp/`. Keep these copies in
sync when the logo changes.

## Layout and UX principles

- Preserve evidence visibly: provide “View original message” affordances.
- Use buyer-facing language on public surfaces, such as “Available” rather
  than internal lifecycle labels.
- Keep the Market Inbox denser and operational; keep public listing cards
  simpler and buyer-facing.
- Use wide max-width containers on marketing pages.
- Keep empty states descriptive and explain why they are empty.
- Show real freshness and source broker context wherever inventory is shown.
- Keep all interactive controls keyboard-navigable.
- Never use color as the only status indicator.
- Never show fake counters, placeholder content, or unsupported intelligence
  claims.

## Product boundaries

- Every market record must remain traceable to WhatsApp evidence.
- Same building does not mean the same unit; listings must not be
  automatically merged.
- Shared-network records must be labelled as shared network data.
- Private CRM records are private by default and are not market evidence.
- Phone numbers must never be embedded in public HTML.

## Open brand decisions

- Keep the logo’s sage-green mark as a distinct, recognizable mark while the
  surrounding public interface uses the forest-and-cream palette above.
- Formalize the icon and illustration style.
- Document logo clear space, minimum size, and misuse rules.
- Consolidate the assistant-specific voice guidance into the broader brand
  voice when that guide stabilizes.

## Related source documents

- [`docs/PRODUCT.md`](docs/PRODUCT.md)
- [`docs/UX.md`](docs/UX.md)
- [`docs/SEO.md`](docs/SEO.md)
- [`docs/DATA_QUALITY.md`](docs/DATA_QUALITY.md)
- [`architecture.md`](architecture.md)
- [`packages/design-tokens/tokens.css`](packages/design-tokens/tokens.css)
