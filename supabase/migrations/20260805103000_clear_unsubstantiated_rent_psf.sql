-- A rent_per_sqft value is only valid when the source quote explicitly says
-- per sqft/PSF. Otherwise the public listing view multiplies a monthly rent
-- by the area and can display a fabricated sale-scale amount.

update public.residential_rent_listings
set rent_per_sqft = null,
    needs_review = true,
    corrected_fields = array(
      select distinct unnest(array_append(coalesce(corrected_fields, '{}'::text[]), 'rent_per_sqft'))
    ),
    corrected_at = coalesce(corrected_at, now()),
    updated_at = now()
where rent_per_sqft is not null
  and coalesce(price_raw_text, '') !~* '(psf|per[[:space:]]*(sq\.?[[:space:]]*)?ft)';

update public.commercial_rent_listings
set rent_per_sqft = null,
    needs_review = true,
    corrected_fields = array(
      select distinct unnest(array_append(coalesce(corrected_fields, '{}'::text[]), 'rent_per_sqft'))
    ),
    corrected_at = coalesce(corrected_at, now()),
    updated_at = now()
where rent_per_sqft is not null
  and coalesce(price_raw_text, '') !~* '(psf|per[[:space:]]*(sq\.?[[:space:]]*)?ft)';
