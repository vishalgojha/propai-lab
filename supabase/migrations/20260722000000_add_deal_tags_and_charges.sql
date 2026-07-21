-- Add deal_tags + additional_charges to parsed_output and listings.
--
-- Background: the Elite Auction / Andheri West message quoted two categories
-- of information that the existing schema could not represent:
--   1. Deal urgency/type signals ("DISTRESS SALE") — a strong buyer-intent
--      trigger that was being silently dropped.
--   2. Itemized additional charges ("+Society Dues: 10 Lakhs",
--      "+Professional Fees: 3% of the Reserve Price") that buyers need to
--      see separately from the headline price.
--
-- This migration widens the schema so ai_extraction.py can surface both
-- fields and so storage/supabase.py can copy them onto the listings row.

alter table parsed_output
    add column if not exists deal_tags text[] default '{}',
    add column if not exists additional_charges jsonb default '[]';

alter table listings
    add column if not exists deal_tags text[] default '{}',
    add column if not exists additional_charges jsonb default '[]';

-- GIN index so buyer-intent queries like
--   "all listings tagged distress_sale in Bandra West"
-- don't fall back to a seq scan.
create index if not exists idx_listings_deal_tags on listings using gin(deal_tags);
