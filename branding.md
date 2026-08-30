# PropAI Brand & Interface System

Status: final Direction B — **Monsoon Market Board**.

PropAI is an independent intelligence layer for Mumbai real-estate brokers.
It reads fast-moving broker conversations, preserves the evidence trail, and
turns shorthand like `2.25 Cr · 950 carpet · BKC · OC` into useful market
signals. The visual system must feel native to that work without pretending to
be an official WhatsApp product.

## Visual references

The system is derived from four concrete scenes:

1. A broker scanning 140 WhatsApp groups: dense timestamps, muted-group rows,
   sender names, unread counts, forwarded messages, and voice-note bursts.
2. Mumbai monsoon streets: wet asphalt, blue-green reflected light, and
   signage that remains legible through haze and rain.
3. Real-estate shorthand on a phone: `₹85k`, `2.25 Cr`, `950 carpet`, `3 BHK`,
   floor, parking, OC, locality, and availability compressed into one message.
4. The broker's trust decision: “confirmed by owner,” “seen in group,” or
   “old/forwarded.” Verified evidence needs a clear marker; rumor needs a
   visible warning without being mistaken for a failed system state.

## Token plan: Monsoon Market Board

These six colors are the core palette. They are not a WhatsApp clone, a
terracotta editorial palette, or a black-plus-neon AI console.

| Token | Hex | Role |
| --- | --- | --- |
| `asphalt` | `#16252B` | Internal app surface: dense, cool, high-focus work area |
| `monsoon-teal` | `#287D82` | Navigation, links, selected structural surfaces, market context |
| `mist` | `#DDE8E5` | Public reading surface and calm buyer-facing canvas |
| `signal-lime` | `#8BCB68` | Live/verified marker and primary internal action |
| `taxi-amber` | `#E0A52B` | Crore/lakh prices, freshness, attention, stale-but-usable data |
| `alert-vermilion` | `#C94B3F` | Failed, blocked, destructive, or evidence-warning state |

### Contrast-checked surface variants

The vivid markers are intentionally reserved for the dark `asphalt` register:

- `signal-lime` on `asphalt`: **8.13:1**
- `taxi-amber` on `asphalt`: **7.19:1**

Both pass WCAG AA for text and UI components. On the light `mist` surface,
the vivid markers fail (`1.55:1` and `1.75:1`), so public semantic tokens use
accessible variants rather than weakening the core palette:

- `signal-lime-on-mist` — `#2F6B3A`, **5.10:1** on `mist`
- `taxi-amber-on-mist` — `#8A5A00`, **4.73:1** on `mist`

These variants pass the 4.5:1 body-text requirement and the 3:1 UI/large-text
requirement. Color is never the only status cue; pair it with text, icon, or
an evidence label.

## Signature element: the Market Rail

The signature element is the **Market Rail**: a thin monsoon-teal line or
short vertical evidence spine connecting a source message/time to structured
property facts and the next action. It can include a paired-tick verification
mark or a small timestamp notch. It should make provenance scannable, not
pretend that two separate units are one listing.

The Market Rail is not a WhatsApp logo, not a chat-bubble skin, and not a
decorative background pattern.

## Typography and geometry

- **Inter** — navigation, controls, body copy, and interface hierarchy.
- **IBM Plex Serif** — restrained public headlines and editorial emphasis;
  never prices or dense metadata.
- **IBM Plex Mono** — crore/lakh values, sqft, BHK/configuration, timestamps,
  source IDs, confidence, and status labels.

Use a 4px spacing scale: `4, 8, 12, 16, 20, 24, 32, 40, 48, 64`.

- Internal cards: 16–20px padding, 12px radius, compact 8–12px fact gaps.
- Public cards: 20–24px padding, 16px radius, generous reading whitespace.
- App gutters: 24px desktop and 16px mobile.
- Mobile controls: minimum 44px tap target.
- Prefer one clear alignment edge over nested rounded containers.

## Two registers on one token system

### Dense internal register

Used by Broker OS, Market Inbox, My Deals, reports, Broker Profiles,
automations, PropAI Ops, Super Admin, and audit/ops views. Use asphalt as the
working canvas, canopy-like teal grouping, monospace property facts, compact
rows, Market Rails, real freshness, and strong active navigation. The UI
should support scanning between calls, not resemble a generic AI dashboard.

### Calm public register

Used by `propai.live`, homepage, search, locality, building, and listing
pages. Use mist surfaces, teal structure, accessible dark marker variants,
more whitespace, fewer fields, buyer-facing labels, consistent PropAI
branding, and one clear Contact Broker action. It should feel like the same
market intelligence becoming easier for a buyer to read.

## Component and state rules

### Status

Always pair color with a label and, where useful, a timestamp:

- **Running:** lime marker, “Running,” and a restrained pulse on the Market
  Rail.
- **Live/fresh:** lime marker, “Live,” or a real freshness time.
- **Stale:** amber marker, “Stale,” last-seen time, and recovery action.
- **Failed:** vermilion marker, “Failed,” concise cause, and Retry/Inspect.
- **Blocked:** vermilion marker, “Blocked,” plus the missing input or access.

Errors must be legible and visually demanding; never use washed-out red-on-dark
messages.

### Evidence confidence

- **High confidence:** source-backed facts visible; show the original-message
  affordance.
- **Review:** name the missing, conflicting, or weak evidence.
- **Low/unusable:** do not present as a clean opportunity; route to review or
  explain why it is withheld.

Confidence is evidence quality, not a decorative percentage.

### WhatsApp-linked and Shared Market

- **WhatsApp-linked:** use the lime signal, explicit “WhatsApp-linked” label,
  safe source context, and an evidence action.
- **Shared Market:** use teal/mist context, explicit “PropAI shared network,”
  and no implication that the viewer is in the originating group.
- Never expose phone numbers in public HTML. Contact uses server-side
  resolution after an intentional action.

### Money and property facts

Show the unit: `₹2.25 Cr`, `₹85,000 / month`, `950 sqft`, and the source form
when normalization is uncertain. Keep BHK/config, area, furnishing, building,
locality, and availability as structured facts. Never invent missing values or
turn an uncertain figure into a confident calculation.

## Navigation and interaction rules

- App navigation follows broker work: WhatsApp → Workspace → Growth → Settings.
  Section labels are quiet; the active destination gets a filled surface,
  teal/lime rail, icon, and readable label.
- Filter cascades make scope explicit and reset downstream selections when an
  upstream dimension changes.
- Keyboard focus remains visible everywhere.
- Loading, empty, stale, and failed states explain what is happening without
  fake counters or generic `N/A` filler.
- Agent chat uses structured message, tool-call, and status states rather than
  dumping raw Markdown walls.

## Anti-drift guardrails

Avoid:

- WhatsApp green as the primary brand identity or any suggestion of official
  WhatsApp affiliation;
- near-black plus a single neon accent;
- warm-cream/terracotta editorial clichés;
- registry, government-portal, or document-stamp styling;
- generic AI gradients, glowing blobs, or decorative dashboard chrome;
- a pill for every fact;
- color-only status/confidence indicators;
- public pages without the PropAI mark or with a disconnected visual language;
- claims of complete market coverage or guaranteed matching.

## Implementation mapping

Wire these tokens once through the shared CSS variables and Tailwind layers
used by `frontend/` and `apps/www/`. Use shadcn/ui primitives for cards,
badges, alerts, controls, and focus states. Use assistant-ui for PropAI Ops,
Super Admin agent chat, and the in-app AI Assistant so streaming messages,
tool calls, and structured statuses are native rather than hand-rolled.

This document governs frontend presentation only. It does not change
extraction, matching, dedupe, evidence, consent, or other backend behavior.
