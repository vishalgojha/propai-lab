-- Do not let clearly non-property-scale values remain active commercial sales.
-- These rows are retained for audit/source review, but their price is removed
-- from feed projections until a human or a corrected extraction confirms it.
update public.commercial_sale_listings
set total_asking_price = null,
    price_per_sqft = null,
    needs_review = true,
    extraction_confidence = 'low',
    validation_flags = case
      when jsonb_typeof(validation_flags) = 'array'
        then validation_flags || '["price_below_range_COMMERCIAL_sale", "price_nullified_by_validation"]'::jsonb
      else '["price_below_range_COMMERCIAL_sale", "price_nullified_by_validation"]'::jsonb
    end,
    updated_at = now()
where coalesce(total_asking_price, 0) > 0
  and total_asking_price < 1000000;

comment on table public.commercial_sale_listings is
  'Typed commercial sale observations. Values below INR 10 lakh are quarantined by the extraction quality gate.';
