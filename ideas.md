# PropAI Mockup — Design Direction

## Three directions considered

### Theme Name: Mumbai Editorial Utility
Very Brief Intro: A light, editorial interface that treats live inventory like a well-edited city guide: calm paper tones, sharp information hierarchy, and a precise green signal for freshness.
Probability: 0.07

### Theme Name: Coastal Modernism
Very Brief Intro: A bright, airy direction inspired by Mumbai's coastal light, using blue-grey surfaces, generous gutters, and soft architectural geometry to make property search feel open and navigable.
Probability: 0.03

### Theme Name: Broker Signal
Very Brief Intro: A restrained product-led system built around real-time cues, contact affordances, and compact evidence blocks, with a warmer contrast palette and a slightly more operational tone.
Probability: 0.09

## Selected approach: Mumbai Editorial Utility

### Design Movement
Contemporary Swiss editorial design adapted for a Mumbai property intelligence product: rigorous grid logic, asymmetrical composition, typographic contrast, and visible information provenance without feeling institutional.

### Core Principles
1. **Signal before decoration.** Freshness, locality, price, and enquiry paths should be scannable in under a few seconds.
2. **Light surfaces, strong edges.** Use warm white and pale stone surfaces with visible borders, restrained shadows, and no dark listing blocks.
3. **Editorial asymmetry.** Let the hero search and network snapshot create a left-right rhythm rather than centering every element.
4. **Human handoff.** Every major interaction should make the transition from browsing to a real WhatsApp broker feel direct and trustworthy.

### Color Philosophy
The canvas is a warm, almost-paper white (#F8F8F5) so the product feels calm and credible rather than promotional. Ink navy (#18232B) provides strong reading contrast; graphite grey supports metadata without disappearing; a restrained PropAI green (#2F6E4F) marks verified, live, and action states; a pale mint (#E6F1EA) creates a quiet signal field for freshness without turning into a dark brand block. A subtle saffron note (#C98535) appears only for time-sensitive freshness cues, echoing Mumbai light and keeping the system ownable.

### Layout Paradigm
A narrow persistent header leads into an asymmetrical hero: an editorial headline and search rail on the left, a compact live-network snapshot on the right. Content then resolves into a consistent 3-column listing rhythm, followed by a horizontal locality rail and a light three-step process block. On mobile, the structure becomes a single column with the hero snapshot condensed beneath the search and horizontal scrollers used only where they preserve browsing speed.

### Signature Elements
- **Live rail:** a thin green status line with a compact dot and timestamp that appears in the hero snapshot and listing freshness rows.
- **Bracketed data labels:** small label + value pairs with hairline rules, inspired by broker sheets and city guides.
- **Signal arrow:** a slender arrow motif used for locality exploration, listing views, and WhatsApp handoff CTAs.

### Interaction Philosophy
Interactions are decisive and low-friction. Search is the primary action, toggles feel like a segmented control rather than tabs, and listing cards reveal affordance through border color, a slight lift, and a green arrow—not heavy animation. Suggested searches should be one-click inputs. Placeholder navigation links remain visible but use a small toast or inline note rather than pretending to be complete product flows.

### Animation
Use short 160–220ms ease-out transitions for hover, focus, button press, and card lift. On first load, stagger hero copy, search, and the network snapshot by 50ms increments; listing cards can fade and translate upward by 8px in 60ms intervals. Use transform and opacity only. Pause all non-essential motion under `prefers-reduced-motion: reduce`; live status should remain a static dot in that mode.

### Typography System
Use **DM Sans** for interface copy and metadata because it is compact and highly legible at small sizes. Pair it with **Newsreader** for the hero headline and a few editorial section cues, using italics sparingly to signal warmth. Headline scale: 56/0.95 desktop, 42/1 mobile; section titles: 30/1; listing titles: 17/1.2; body: 15/1.5; metadata: 11–12/1.3 with modest tracking. Avoid all-uppercase section titles; use sentence case with occasional small caps only for labels.

### Brand Essence
**PropAI helps Mumbai home seekers find live broker inventory before it becomes stale, then moves the conversation directly to WhatsApp.**
Personality adjectives: observant, direct, city-smart.

### Brand Voice
Headlines sound assured and useful, never inflated. CTAs are specific and action-led. Microcopy explains what is happening in plain English and makes provenance visible.

Example lines:
- “The right home often appears in a conversation first.”
- “Tell us the brief. We’ll surface what’s moving now.”

### Wordmark & Logo
Use a custom geometric mark built from two offset brackets forming a small doorway / signal glyph, paired with a compact PropAI wordmark in a rounded grotesk. The icon should work alone at favicon size and beside the wordmark in the header; avoid a generic house outline.

### Signature Brand Color
**Signal Green — #2F6E4F.** It is calm enough for a premium property product, legible on warm paper, and meaningful as the visual shorthand for live, verified, and direct.

## Implementation reminders

- Light background throughout; no dark green listing surfaces.
- Keep Mumbai terms such as BHK, carpet area, OC, Jodi, and WhatsApp.
- Preserve the live-site listing URL examples, e.g. `/listings/3-bhk-for-sale-30627/30627`.
- Keep the natural-language search as the primary interaction and support Rent / Buy / Commercial modes.
- Use `Card`, `Badge`, `Button`, `Command`, `Breadcrumb`, and Empty State patterns where they improve clarity.
- Do not invent reviews, ratings, or testimonials.
- Place style notes at the top of each edited CSS/component/page file.
