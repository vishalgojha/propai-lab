# PropAI Product Architecture

This document captures the product decisions behind PropAI so implementation does not drift into a generic WhatsApp clone or generic CRM.

## Core Thesis

PropAI is a broker-first market intelligence and workflow system.

WhatsApp is the data source, not the product model. The product should turn noisy real-estate group activity into searchable broker entities, fresh opportunities, private workspace workflows, and AI/MCP tools.

## Product Layers

### 1. Raw WhatsApp Archive

Raw WhatsApp messages are stored as evidence and should not be thrown away.

Raw messages may contain:
- one listing
- many listings
- requirements
- mixed listings and requirements
- forwarded inventory
- embedded contact details
- noisy/non-real-estate text

Raw messages are the source of truth, but they are not the primary UX object.

### 2. Parsed Opportunities

Each listing or requirement extracted from a raw message becomes an individual opportunity atom.

One WhatsApp dump with 30 listings should create 30 searchable opportunity records, each linked back to the original raw message.

Opportunities should track:
- type: listing or requirement
- deal subtype: rent, sale, lease, commercial, residential, etc.
- BHK/configuration
- building/locality/micro-market
- price/budget
- area
- contact roles
- source group
- source sender
- first_seen
- last_seen
- times_seen
- active_until
- confidence

### 3. Broker Identity Graph

Mobile number is the identity spine.

There may be many brokers named "Vishal Ojha", but only one broker owns a verified phone number like `9820056180`.

Rules:
- Never merge broker entities only because names match.
- One broker/contact entity is anchored by normalized phone.
- Names, agencies, and WhatsApp profile names are aliases, not proof of identity.
- QR/WhatsApp verification links a PropAI user to the broker entity for that phone.
- Multiple phone numbers should remain separate broker/contact entities initially.
- Agency/team is a grouping layer, not an identity merge.

### 4. Contact Roles On Opportunities

An opportunity can involve multiple people.

Minimum roles for v1:
- owner: broker/agency that controls or owns the opportunity
- contact: person to call for inspection/deal action
- source: WhatsApp sender or distributor who posted/forwarded it

Example:
- Harikirat/Gurukripa owns the listing
- Amit is inspection contact
- Rajesh posted it in Bandra Broker Group

The listing card should show the actionable contact first, while preserving owner/team/source evidence.

For forwarded messages:
- Contact inside the message wins as opportunity owner/contact when confidence is high.
- WhatsApp sender remains source/distributor.
- Store both and expose confidence.

## Dedupe vs Clustering

PropAI must never globally merge similar properties from different agents.

### Dedupe

Dedupe only within the same broker/contact/team identity.

If the same broker posts the same listing or requirement multiple times, keep one active opportunity and update:
- last_seen
- times_seen
- latest_source_message
- source groups

Freshness is the primary ranking signal because brokers repost active inventory/requirements multiple times a day until fulfilled.

### Clustering

Cluster similar opportunities across different brokers without merging them.

Example listing cluster:
- 3BHK Rizvi Palace, Bandra West
- Shoaib @Elite: Rs 2.66 Cr, seen 1h ago
- Broker B: Rs 2.70 Cr, seen 4h ago
- Broker C: Rs 2.75 Cr, seen yesterday

Example requirement cluster:
- 3BHK rent, Bandra/Khar, budget 1.5L-2L
- Broker A: family client, seen 20 min ago
- Broker B: expat tenant, seen 2h ago
- Broker C: corporate lease, seen yesterday

Clusters create market intelligence. Individual broker records remain separate actionable opportunities.

## Market Inbox

Market Inbox is a personalized opportunity feed, not a chat inbox.

It should show broker/contact entities and their fresh opportunities, not WhatsApp group names as the primary object.

Default scope: My Market.

My Market is inferred from the broker's own parsed activity:
- operating localities
- buildings
- price bands
- rent/sale/commercial tendency
- BHK/configuration focus

Users can switch scope:
- My Market
- Show All
- selected locality corridor such as Bandra-Khar or Lower Parel-Worli
- search locality/building

Tabs/filters:
- All Opportunities
- Listings
- Requirements
- Brokers

Ranking:
1. Freshness / last_seen
2. Match to user's operating market
3. confidence / repeated sightings

Market Inbox actions:
- Save
- Match to Client
- Contact
- More

More can include:
- Add to Deal
- Hide
- View Source

Market Inbox should not become the CRM. It is discovery.

## Workspace Layer

Workspace is private operating data for the broker.

### My Clients

My Clients is demand CRM.

It stores:
- client requirements
- shortlists
- matched market listings
- follow-ups
- client feedback
- requirement status

Action example:
A broker sees Vishal's 2BHK listing in Market Inbox and clicks "Match to Client". PropAI asks which requirement to attach it to, then adds that listing as a candidate under the selected client requirement.

### My Deals

My Deals is supply/deal CRM.

It stores:
- saved listings
- owner/broker contacts
- inspection status
- negotiation notes
- pipeline stages
- tasks and follow-ups

### Save vs Add to Deal

Save is lightweight:
- bookmark/watchlist
- no pipeline stage
- no client attached

Add to Deal is heavier:
- creates pipeline record
- tracks status, notes, tasks, contact history

### Contact Activity

Every meaningful action should create an activity record.

Contact actions should log:
- who was contacted
- opportunity/listing/requirement
- timestamp
- call/WhatsApp/reveal method
- source: Market Inbox, AI Chat, MCP, etc.
- own graph vs shared network

If a deal is later created, prior contact activity can become part of the deal timeline.

## Privacy, Consent, And Visibility

Default posture:
- Shared Market is opt-out, not opt-in.
- DMs are private by default.
- Excluded groups never contribute to shared market.
- Real-estate groups are eligible for market parsing.
- Private/client/family/friends groups should be auto-detected and excluded where possible.

After WhatsApp scan, PropAI should show a privacy receipt:
- market groups detected
- private/non-market groups excluded
- DMs not shared
- excluded groups can be reviewed
- shared market is on by default

Group review should be exception-based. Brokers should not need to manually select every real-estate group.

Backend enforcement must not be UI-only. Parsed objects should carry fields such as:
- tenant_id
- visibility: shared_market or workspace_private
- source_scope: group, dm, excluded_group
- contributor_user_id
- broker_opt_out
- active_until / last_seen

## Trial And Access

Signup is account creation, not trial activation.

Trial starts only after:
1. WhatsApp connected successfully
2. initial sync/classification is complete enough to create value
3. privacy receipt / group opt-out step is completed

No WhatsApp scan + no active trial/paid plan means no real market feed.

Locked state should say:
"Connect WhatsApp and start your trial to unlock your personalized broker market feed."

Trial should be time-based, not usage-metered for basic discovery.

## Contact Reveal And Broker Network

Own graph:
- full access to contacts already present in the user's own WhatsApp data

Shared network:
- non-owned broker numbers are masked by default
- reveal rights can be plan/credit based later
- reveal events should be audited

Participating broker analytics:
- who viewed/revealed their contact
- which listing/requirement caused the view
- market interest over time

Unclaimed broker entities:
- phone-number anchored UUID exists before signup
- when the broker joins with the same verified mobile number, the entity is enriched and linked
- no loose claim-by-name/listing flow

Opt-out:
- hide broker network profile
- suppress searchable shared-market presence
- stop future public contribution
- keep minimal compliance/audit records where needed

## AI And MCP

PropAI AI Chat is the built-in convenience layer.

Good for:
- quick market questions
- match explanations
- inbox summaries
- drafting replies
- guided workflows

MCP is the power layer.

Good for:
- Claude/ChatGPT users
- frontier-model reasoning using the broker's PropAI data layer
- external workflows and agents
- BYO AI subscriptions

MCP should be included in all plans and trial initially because it is not a major model-cost burden for PropAI.

Access rule:
External AI via MCP can access what the broker can access in PropAI, not more.

MCP and AI Chat must respect:
- entitlement
- workspace permissions
- group exclusions
- private workspace boundaries
- contact reveal rights
- opted-out/purged entities

## Launch-Scope Role Model

Keep the first implementation simple:
- owner
- contact
- source

Do not overbuild agency/team attribution in the first pass. Preserve enough evidence to improve later.

## Non-Negotiables

- Do not make PropAI a WhatsApp clone.
- Do not show raw group chats as the primary market object.
- Do not globally merge similar properties across different brokers.
- Do not rely on names as identity proof.
- Do not make privacy toggles cosmetic; enforce them in backend queries.
- Do not show real market feed before WhatsApp scan plus active trial/paid entitlement.
- Do not parse excluded/private groups into shared market.
- Do not let MCP access more than the PropAI app allows.
