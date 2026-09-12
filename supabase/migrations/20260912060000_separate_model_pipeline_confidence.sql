-- Keep model judgment separate from publication-safety review state.
-- Additive and nullable for compatibility with historical typed rows.
do $$ declare t text; begin
  foreach t in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings',
    'residential_sale_requirements', 'residential_rent_requirements',
    'commercial_sale_requirements', 'commercial_rent_requirements'
  ] loop
    execute format('alter table public.%I add column if not exists model_confidence numeric', t);
    execute format('alter table public.%I add column if not exists pipeline_review boolean not null default false', t);
    execute format('alter table public.%I add column if not exists pipeline_review_reasons jsonb not null default ''[]''::jsonb', t);
  end loop;
end $$;
