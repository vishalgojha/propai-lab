# Market Inbox: product brief and repair checklist

## Product contract

PropAI has two distinct WhatsApp surfaces:

- **WhatsApp Groups** is the faithful WhatsApp-style mirror: group, sender, original text, media, reply context, and time.
- **Market Inbox** is the structured market view created from those group posts. It is organised around a broker entity and their listings/requirements, never around the raw group chat itself.

The flow is:

```text
WhatsApp group post (evidence)
  -> Whatsmeow ingestion
  -> raw message stored
  -> AI extraction, including multi-listing split
  -> broker identity resolution
  -> structured Market Inbox item
  -> My Deals for the owning broker / global market when publishable
```

## Broker identity rule

A verified WhatsApp contact route is mandatory before a parsed post becomes a usable **broker Market Inbox entity**. Usually this is the phone number; WhatsApp may first supply a Meta LID (`user@lid`), which must be resolved through Whatsmeow's LID-to-phone mapping.

- Prefer the normalised phone-number JID / resolved LID phone whenever WhatsApp supplies it.
- Store the Meta LID and phone mapping as identity evidence, but use the resolved phone as the broker's contact route.
- If a message has no resolvable contact route yet, retain it in the raw Groups mirror and an internal `identity pending` queue. It is **not** a completed broker entity and must not pollute Market Inbox.
- Retry LID-to-phone resolution from Whatsmeow's stored mapping; once it resolves, promote the existing raw post into the broker entity without reparsing its property data.
- Never use a property phone mentioned inside the message as the sender/broker identity unless explicitly marked as the poster's number.
- Record the identity confidence and source: `sender_jid`, `sender_phone`, `profile/display name`, or `message contact`.

The awkwardness today is real: parsing can successfully produce a listing while WhatsApp sender identity is incomplete. The correct behaviour is **raw evidence retained + identity-resolution retry**, then a usable phone-backed broker—not a fake name-only broker and not a silent loss.

## What Market Inbox does today

1. Reads extracted `parsed_output` records that came from group messages.
2. Groups them by parsed broker phone, raw sender phone/JID, or a name fallback.
3. Shows a broker list. Selecting one loads their extracted observations and the raw WhatsApp evidence.
4. Falls back to broad parsed/raw scans when indexed RPC paths fail.

## Current problems to finish

### P0 — broker identity

- [ ] Fix ingestion so a phone resolved from a Meta LID is stored even when Whatsmeow sends it as bare digits.
- [ ] Make identity resolution phone/LID-map first; do not create Market Inbox brokers from a display name alone.
- [ ] Keep unresolved senders in raw Groups plus an `identity pending` queue, then promote them after mapping resolution.
- [ ] Display identity status in Market Inbox: verified phone / LID resolved / identity pending.
- [ ] Preserve the exact sender JID and source group as evidence for every merge.

### P0 — structured inventory, not chat cards

- [ ] Replace the centre-panel WhatsApp/card hybrid with compact structured rows/bullets.
- [ ] One multi-listing source message must create one row per real unit/listing.
- [ ] Keep a small evidence affordance on each row: group name, time, and open-original-message.
- [ ] Make listing vs requirement unmistakable, and show key fields first: transaction, type/BHK, furnishing, building, locality, floor, area, price, availability.

### P0 — no black holes

- [ ] A group post with no completed extraction must remain visible as `Processing` or `Needs review` under its broker/provisional sender.
- [ ] Do not show “no matching items” when raw evidence exists; state the actual extraction/identity state.
- [ ] Provide retry/reprocess only for the affected post, with a reason if it failed.

### P1 — performance and correctness

- [ ] Make indexed RPC queries the primary feed path; remove broad 50k-row client-side fallback scans from normal operation.
- [ ] Do not rebuild the broker graph while opening an individual profile.
- [ ] Paginate broker entities and structured items separately.
- [ ] Keep stable broker IDs so refreshes do not reshuffle or lose selection.

### P1 — ownership and downstream use

- [ ] A broker-authenticated listing saves to that broker's **My Deals**.
- [ ] Eligible active listings are added to the global market/public search.
- [ ] Group-extracted listings remain market intelligence with provenance; do not falsely claim they are owned by the connected broker.
- [ ] Requirements should be globally matchable and produce broker-visible match events.

## Target broker view

```text
Khan Properties · verified +91…
12 listings · 4 requirements · active in 3 groups

LISTINGS
• Rent · 3 BHK · Semi-furnished · Ten BKC, Tower 7
  1,360 carpet · 24th floor · ₹3L
  Today · All Bombay · View original WhatsApp post

• Rent · 3 BHK · Semi-furnished · Ten BKC, Tower 7
  1,360 carpet · 17th floor · ₹3L
  Today · All Bombay · View original WhatsApp post

REQUIREMENTS
• Buy · 3 BHK · Bandra East or BKC · ₹6–8 Cr
  Unfurnished/furnished irrelevant · Database search requested
```

## Definition of done

For any new post in a connected WhatsApp group, a broker can open Market Inbox and see either:

1. the correctly structured listing/requirement under the right broker, with direct original-message evidence; or
2. a clearly labelled processing/review item explaining why it has not become structured yet.

No valid post silently disappears.
