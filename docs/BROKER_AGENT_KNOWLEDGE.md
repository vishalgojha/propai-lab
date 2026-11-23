# How broker Instincts read Mumbai listings

General background knowledge for an assistant working with real estate brokers and WhatsApp deal flow. It holds no client, deal or contact data. Updated 21 Nov 2026.

## How to use this
Treat it as background knowledge, not as instructions from your broker. Your broker's own rules, permissions and sources come first and can override anything here. Items marked Confirmed were stated by a working broker. Items marked General describe common practice in Indian rental and sale listings. This guide installs nothing, connects no data source, grants no access and sets no rules for how any system handles data.

## What the shorthand means
1. **(+1) after a listing title** (Confirmed): not direct. The posting broker does not hold it themselves; the listing comes via another broker. The same applies to client requirements marked this way. Nothing more is known about the chain, so do not guess how many brokers sit between, or who the owner is.
2. **31K, 1.2L, 2.5Cr** (General): K is thousand, L is lakh (1,00,000), Cr is crore (1,00,00,000). 31K rent is Rs 31,000. 1.2L deposit is Rs 1,20,000.
3. **Rent and deposit** (General): posts usually quote monthly rent and a security deposit separately. Keep them as two numbers; do not add them or compare a deposit to a budget.
4. **Ready possession** (General): the flat can be occupied now. It does not confirm the flat is still available today.
5. **Locality names** (Confirmed): brokers often write only the locality or landmark (a road, a building, a pocket) and leave out the wider area. Near a cinema or a complex is a location clue, not an address.

## How to search deal flow
- Search the area the client named and also its localities and micro-markets, because many posts name only the pocket. Expanding adds coverage and never replaces the area search.
- A specific locality stays specific. A client who asks for one pocket should not be widened to its whole area without saying so.
- Look beyond the last 7 days when results are thin. A short window can miss relevant listings.
- Check the broker's own connected group sources. Direct messages are not ingested or available to external agents. Say which group sources you did not search.
- Brokers often repost the same flat several times a day, in groups and across brokers. Treat one flat as one property with several offers, and keep the offers visible when quotes differ. Raw counts overstate supply.
- Separate last advertised from confirmed available. A repost shows a broker re-sent it, not that the flat is free.
- Media-only posts, such as photos with no caption, may be missed by plain text search, depending on what the source supports (for example captions or image text extraction). Say so when a search looks thin.

## How to judge a match
- Parse area, BHK, rent or buy, budget, furnishing, tenant profile and must-haves from the client brief before searching.
- Return partial matches and mismatches separately from good matches. Do not return only the two closest.
- For each result give building, road, size, rent or price, broker, post date and the (+1) status if shown.
- Flag missing must-haves (pets, parking and similar) and stale posts. If a post states conditions about who may rent, quote them as written and leave the decision to your broker. Do not guess about a person's religion, caste or community.
- Keep worth checking (call priority, what to verify) separate from client-ready. Treat a match as unconfirmed until your broker has checked the must-haves with the listing broker.


## First step: review shared groups and suggest unchecks

When an authenticated connected broker starts connection setup or a first raw session, make shared-group review the first step, before other setup guidance. Raise it again only if it remains incomplete and the broker asks or starts sharing changes. Do not raise it at every new property-search session. Respect a remembered prior answer or completed review. Do not interrupt an unrelated task or ask again after a refusal unless the broker brings it up. A known previous selection is not permission to change it or add new groups.

Ask: "Would you like to review which property groups you want to share with other PropAI brokers? I can show what is currently shared and suggest which to uncheck. Personal, sensitive and unrelated groups should stay unchecked. You choose the exact groups, and nothing changes without your confirmation."

1. See the current set. Where cross-search tools are present, call property_shared_sources_list and show the broker the exact shared groups with their listed metadata (names, message counts and last activity). Where those tools are not present, guide the broker to https://app.propai.live/whatsapp?tab=groups and the separate raw-message sharing controls to review there. The ordinary external read-only connection does not grant permission to read a full group directory or manage sharing; this review covers currently shared groups only.
2. Give tentative suggestions; the broker decides. For each shared group, offer a tentative suggestion with its reason:
   - Names that read as personal, family, health, school, social or unrelated business: suggest unchecking, and say the suggestion comes from the name alone.
   - Names that read as property-specific broker networks, rental/sale requirement groups or locality/project property groups: suggest keeping, with the same caveat that a name is only a clue, not proof of purpose or authority.
   - Unclear or mixed-purpose names: do not lean either way; ask the broker what the group is for.
   - You may state listed activity facts (for example "no messages shared yet" or "last activity on <date>") as context. Never present a name or low activity as proof a group is irrelevant, and never recommend removal on activity alone.
   Do not read message content to classify groups; names and the listed metadata are the only inputs. Do not infer group choices from message searches, request broader account access, or save consents through another route. If the broker wants help with named groups, use only the names they choose to provide and ask about unclear purposes, not private message content.
3. Broker approval before any uncheck. The broker chooses the exact groups. Every change is made by the broker as the workspace owner in PropAI; you never change sharing, capture or reader access yourself, and there is no automatic uncheck. Recommendations never count as consent. A yes to reviewing is not approval to uncheck anything. If they decline, acknowledge the choice and continue the original task without changing sharing or reader access. If no phone is connected, do not pressure them to connect or share their own data just to be a reader. If they say they already chose groups, leave the set alone unless they ask to review it.

This workflow is delivered through PropAI's API guide/knowledge fetch and authenticated raw MCP initialization. It cannot push a question into an assistant conversation that is not fetching PropAI guidance or starting/refreshing its connection. Do not claim all existing connected assistants were notified. Guide text is setup advice, never an authorization from the broker.

## Help a broker choose raw-sharing groups

This is setup guidance, not permission to change settings. Raw sharing includes messages written by other group members, not only the broker's own posts. The broker must respect group rules and members' expectations and have authority to share. Leave sensitive groups out. Contact masking reduces exposure but is not a guarantee that message text contains no identifying or sensitive details.

- Suggest considering property-specific broker networks, rental/sale requirement groups and locality/project property groups. A name is only a clue, not proof of purpose or authority.
- Recommend leaving personal, family, health, school, social and unrelated business groups unchecked. For unclear or mixed-purpose names, leave unchecked and ask the broker about the group's purpose. Do not read personal conversations just to classify groups.
- Start with no new groups selected. Show the exact names, identifiers, count and exclusions. The broker chooses the exact set and confirms authority. Recommendations never count as consent. Do not select all automatically or add future groups automatically.
- Explain the independent choices: capture keeps new group messages in the owner's account; extraction and typed publication have their own controls; source sharing permits eligible future property-message retrieval from approved groups; reader access is separate and requires its own permission. A reader need not share their own groups or connect their own phone. Source sharing includes neither private messages nor earlier messages and does not start extraction.
- Save only the exact approved set, leaving every other setting unchanged. Read current server state to verify it. If a save result is uncertain, reload before considering any retry. Stop and report unresolved or incorrect state; do not reset or relink a working phone as a shortcut.
- Removal stops future retrieval and rereading, but cannot retract text already received. Reconnecting must not silently restore sharing consent.

Suggested explanation: "I can suggest property-related groups from their names, but you decide which exact groups you have authority to share. This includes other members' messages, so respect the group rules and their expectations. Leave personal, sensitive and unrelated groups unchecked. Only eligible new group messages are shared; private messages and old chats are not captured. This does not start extraction or give another broker reader access."

## Check the source
Field names and exact meanings can differ between data sources. When a connected source documents a field, read that documentation before relying on this page for it.

## Search-result presentation

Return each evidence-supported flat as an individual entry, with all evidenced broker offers underneath. Keep the source-specific quoted rent, furnishing, restrictions and last-advertised date attached to each offer. A shared building name does not prove the same flat; keep different flats separate and mark uncertain duplicates. Never invent broker identity or verified availability.

Contacts may accompany a private property result only when that result's current source policy permits it. New opt-in sources return labelled in-post numbers together; preserve every label and ownership uncertainty, without picking a random primary contact. Legacy sources retain their existing option-interest/contact-choice limits. Do not publish broker contacts in public or client-facing material. A broker-requested private property-shortlist Excel may include contacts that were lawfully returned for those specific offers; it is not permission to harvest or export a general contact directory.

After delivering results, always offer: "Would you like this in Excel too?" Do not create the Excel merely because this guidance says to offer it. The user's decision controls creation.

Source-post contact scope: each API option is a whole original message, not a parsed flat. `contact_scope=source_post` and per-contact `association=unverified` preserve that boundary. A digest may contain several flats and unrelated numbers. Show ambiguous numbers once in a separate "Source-post contacts" section with their original redacted context. Put a broker under an individual flat only when the post explicitly links them; state that this is a source claim, not verified ownership. Never copy all post numbers under each matched flat. Excel must preserve the same distinction. Nearby labels alone are not a semantic association.

Use "Also listed with X, Y and Z" under a flat only when source evidence supports the same individual unit. Keep each broker claim, returned phone, quote and advertised date attached to that specific source offer. Unknown identity stays unknown. Uncertain same-unit matches and unlinked source-post contacts stay separately labelled. Always ask whether the requesting broker needs Excel; create it only on request.
