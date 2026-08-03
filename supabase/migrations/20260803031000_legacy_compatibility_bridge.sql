-- Emergency compatibility bridge after the typed-schema cutover.
-- The application is still being migrated from the legacy relation names. Keep
-- the old read/write contract alive while projecting new parsed rows into the
-- typed tables. This is intentionally temporary.

begin;

create or replace function public._compat_insert_parsed_output()
returns trigger
language plpgsql
as $$
declare
  payload jsonb := to_jsonb(NEW);
  source_text text := coalesce(NEW.normalized_message, NEW.raw_payload->>'full_text', '');
  asset text := public._typed_asset(NEW.asset_type, NEW.property_type, source_text);
  tx text := public._typed_tx(NEW.intent, NEW.transaction_type, source_text);
  source_fp text := md5('live:parsed:' || coalesce(NEW.raw_message_id::text, '0') || ':' || coalesce(NEW.listing_index, 0)::text || ':' || coalesce(NEW.id, 0)::text);
  review boolean := coalesce(NEW.needs_review, false) or NEW.asset_type is null;
  confidence text := case when coalesce(NEW.confidence, 0) >= .8 then 'high' when coalesce(NEW.confidence, 0) >= .5 then 'medium' else 'low' end;
begin
  if NEW.id is null then
    payload := jsonb_set(payload, '{id}', to_jsonb(nextval(pg_get_serial_sequence('public.parsed_output_legacy', 'id'))));
  end if;
  payload := payload || jsonb_build_object(
    'created_at', case when payload->>'created_at' is null then to_jsonb(now()) else payload->'created_at' end,
    'corrected_fields', case when payload->>'corrected_fields' is null then to_jsonb(ARRAY[]::text[]) else payload->'corrected_fields' end,
    'needs_review', case when payload->>'needs_review' is null then 'false'::jsonb else payload->'needs_review' end
  );
  insert into public.parsed_output_legacy overriding system value
  select (jsonb_populate_record(null::public.parsed_output_legacy, payload)).*;

  if lower(coalesce(NEW.message_type, '')) in ('buy', 'requirement')
     or lower(coalesce(NEW.intent, '')) in ('buy', 'buyer', 'requirement', 'rental_seeker', 'tenant', 'demand') then
    if asset = 'commercial' and tx = 'rent' then
      insert into public.commercial_rent_requirements
        (raw_message_id, tenant_id, listing_index, source_fingerprint, asset_type, transaction_type,
         building_name, locality_raw, locality_resolved, micro_market, broker_name, broker_phone,
         summary_title, normalized_message, raw_payload, ai_extraction, deal_tags, additional_charges,
         validation_flags, needs_review, extraction_confidence, corrected_fields, correction_confidence,
         corrected_at, created_at, updated_at, budget_min, budget_max, budget_currency, area_min_sqft,
         area_max_sqft, status, commercial_use_type)
      values
        (NEW.raw_message_id, NEW.tenant_id, coalesce(NEW.listing_index, 0), source_fp, 'commercial', 'rent',
         NEW.building_name, NEW.location_raw, NEW.location_raw, NEW.micro_market, NEW.broker_name, NEW.broker_phone,
         NEW.summary_title, NEW.normalized_message, coalesce(NEW.raw_payload, '{}'), NEW.ai_extraction,
         coalesce(NEW.deal_tags, '{}'), coalesce(NEW.additional_charges, '[]'), coalesce(NEW.validation_flags, '[]'),
         true, confidence, coalesce(NEW.corrected_fields, '{}'), NEW.correction_confidence, NEW.corrected_at,
         coalesce(NEW.created_at, now()), now(), NEW.price, NEW.price, 'INR', NEW.area_sqft, NEW.area_sqft,
         'active', coalesce(nullif(lower(NEW.commercial_use_type), ''), 'mixed_use'))
      on conflict (source_fingerprint) do nothing;
    elsif asset = 'commercial' then
      insert into public.commercial_sale_requirements
        (raw_message_id, tenant_id, listing_index, source_fingerprint, asset_type, transaction_type,
         building_name, locality_raw, locality_resolved, micro_market, broker_name, broker_phone,
         summary_title, normalized_message, raw_payload, ai_extraction, deal_tags, additional_charges,
         validation_flags, needs_review, extraction_confidence, corrected_fields, correction_confidence,
         corrected_at, created_at, updated_at, budget_min, budget_max, budget_currency, area_min_sqft,
         area_max_sqft, status, commercial_use_type)
      values
        (NEW.raw_message_id, NEW.tenant_id, coalesce(NEW.listing_index, 0), source_fp, 'commercial', 'sale',
         NEW.building_name, NEW.location_raw, NEW.location_raw, NEW.micro_market, NEW.broker_name, NEW.broker_phone,
         NEW.summary_title, NEW.normalized_message, coalesce(NEW.raw_payload, '{}'), NEW.ai_extraction,
         coalesce(NEW.deal_tags, '{}'), coalesce(NEW.additional_charges, '[]'), coalesce(NEW.validation_flags, '[]'),
         true, confidence, coalesce(NEW.corrected_fields, '{}'), NEW.correction_confidence, NEW.corrected_at,
         coalesce(NEW.created_at, now()), now(), NEW.price, NEW.price, 'INR', NEW.area_sqft, NEW.area_sqft,
         'active', coalesce(nullif(lower(NEW.commercial_use_type), ''), 'mixed_use'))
      on conflict (source_fingerprint) do nothing;
    elsif tx = 'rent' then
      insert into public.residential_rent_requirements
        (raw_message_id, tenant_id, listing_index, source_fingerprint, asset_type, transaction_type,
         building_name, locality_raw, locality_resolved, micro_market, broker_name, broker_phone,
         summary_title, normalized_message, raw_payload, ai_extraction, deal_tags, additional_charges,
         validation_flags, needs_review, extraction_confidence, corrected_fields, correction_confidence,
         corrected_at, created_at, updated_at, budget_min, budget_max, budget_currency, area_min_sqft,
         area_max_sqft, status, bhk_options, carpet_area_min_sqft, carpet_area_max_sqft)
      values
        (NEW.raw_message_id, NEW.tenant_id, coalesce(NEW.listing_index, 0), source_fp, 'residential', 'rent',
         NEW.building_name, NEW.location_raw, NEW.location_raw, NEW.micro_market, NEW.broker_name, NEW.broker_phone,
         NEW.summary_title, NEW.normalized_message, coalesce(NEW.raw_payload, '{}'), NEW.ai_extraction,
         coalesce(NEW.deal_tags, '{}'), coalesce(NEW.additional_charges, '[]'), coalesce(NEW.validation_flags, '[]'),
         true, confidence, coalesce(NEW.corrected_fields, '{}'), NEW.correction_confidence, NEW.corrected_at,
         coalesce(NEW.created_at, now()), now(), NEW.price, NEW.price, 'INR', NEW.area_sqft, NEW.area_sqft,
         'active', case when NEW.bhk ~ '[0-9]' then array[public._typed_num(regexp_replace(NEW.bhk, '[^0-9.]', '', 'g'))]::numeric[] else '{}' end,
         NEW.area_sqft, NEW.area_sqft)
      on conflict (source_fingerprint) do nothing;
    else
      insert into public.residential_sale_requirements
        (raw_message_id, tenant_id, listing_index, source_fingerprint, asset_type, transaction_type,
         building_name, locality_raw, locality_resolved, micro_market, broker_name, broker_phone,
         summary_title, normalized_message, raw_payload, ai_extraction, deal_tags, additional_charges,
         validation_flags, needs_review, extraction_confidence, corrected_fields, correction_confidence,
         corrected_at, created_at, updated_at, budget_min, budget_max, budget_currency, area_min_sqft,
         area_max_sqft, status, bhk_options, carpet_area_min_sqft, carpet_area_max_sqft)
      values
        (NEW.raw_message_id, NEW.tenant_id, coalesce(NEW.listing_index, 0), source_fp, 'residential', 'sale',
         NEW.building_name, NEW.location_raw, NEW.location_raw, NEW.micro_market, NEW.broker_name, NEW.broker_phone,
         NEW.summary_title, NEW.normalized_message, coalesce(NEW.raw_payload, '{}'), NEW.ai_extraction,
         coalesce(NEW.deal_tags, '{}'), coalesce(NEW.additional_charges, '[]'), coalesce(NEW.validation_flags, '[]'),
         true, confidence, coalesce(NEW.corrected_fields, '{}'), NEW.correction_confidence, NEW.corrected_at,
         coalesce(NEW.created_at, now()), now(), NEW.price, NEW.price, 'INR', NEW.area_sqft, NEW.area_sqft,
         'active', case when NEW.bhk ~ '[0-9]' then array[public._typed_num(regexp_replace(NEW.bhk, '[^0-9.]', '', 'g'))]::numeric[] else '{}' end,
         NEW.area_sqft, NEW.area_sqft)
      on conflict (source_fingerprint) do nothing;
    end if;
  elsif asset = 'commercial' and tx = 'rent' then
    insert into public.commercial_rent_listings
      (raw_message_id, tenant_id, listing_index, source_fingerprint, asset_type, transaction_type,
       building_name, locality_raw, locality_resolved, micro_market, broker_name, broker_phone,
       summary_title, normalized_message, raw_payload, ai_extraction, deal_tags, additional_charges,
       validation_flags, needs_review, extraction_confidence, commercial_use_type, carpet_area_sqft,
       built_up_area_sqft, area_raw_text, monthly_rent, price_raw_text, furnishing_status, created_at, updated_at)
    values
      (NEW.raw_message_id, NEW.tenant_id, coalesce(NEW.listing_index, 0), source_fp, 'commercial', 'rent',
       NEW.building_name, NEW.location_raw, NEW.location_raw, NEW.micro_market, NEW.broker_name, NEW.broker_phone,
       NEW.summary_title, NEW.normalized_message, coalesce(NEW.raw_payload, '{}'), NEW.ai_extraction,
       coalesce(NEW.deal_tags, '{}'), coalesce(NEW.additional_charges, '[]'), coalesce(NEW.validation_flags, '[]'),
       review, confidence, coalesce(nullif(lower(NEW.commercial_use_type), ''), 'mixed_use'),
       coalesce(NEW.carpet_area_sqft, NEW.area_sqft), NEW.built_up_area_sqft, NEW.area, NEW.monthly_rent,
       NEW.ai_extraction->'price'->>'raw_price_text', NEW.furnishing_canonical, coalesce(NEW.created_at, now()), now())
    on conflict (source_fingerprint) do nothing;
  elsif asset = 'commercial' then
    insert into public.commercial_sale_listings
      (raw_message_id, tenant_id, listing_index, source_fingerprint, asset_type, transaction_type,
       building_name, locality_raw, locality_resolved, micro_market, broker_name, broker_phone,
       summary_title, normalized_message, raw_payload, ai_extraction, deal_tags, additional_charges,
       validation_flags, needs_review, extraction_confidence, commercial_use_type, carpet_area_sqft,
       built_up_area_sqft, area_raw_text, total_asking_price, price_raw_text, furnishing_status, created_at, updated_at)
    values
      (NEW.raw_message_id, NEW.tenant_id, coalesce(NEW.listing_index, 0), source_fp, 'commercial', 'sale',
       NEW.building_name, NEW.location_raw, NEW.location_raw, NEW.micro_market, NEW.broker_name, NEW.broker_phone,
       NEW.summary_title, NEW.normalized_message, coalesce(NEW.raw_payload, '{}'), NEW.ai_extraction,
       coalesce(NEW.deal_tags, '{}'), coalesce(NEW.additional_charges, '[]'), coalesce(NEW.validation_flags, '[]'),
       review, confidence, coalesce(nullif(lower(NEW.commercial_use_type), ''), 'mixed_use'),
       coalesce(NEW.carpet_area_sqft, NEW.area_sqft), NEW.built_up_area_sqft, NEW.area, NEW.total_asking_price,
       NEW.ai_extraction->'price'->>'raw_price_text', NEW.furnishing_canonical, coalesce(NEW.created_at, now()), now())
    on conflict (source_fingerprint) do nothing;
  elsif tx = 'rent' then
    insert into public.residential_rent_listings
      (raw_message_id, tenant_id, listing_index, source_fingerprint, asset_type, transaction_type,
       building_name, locality_raw, locality_resolved, micro_market, broker_name, broker_phone,
       summary_title, normalized_message, raw_payload, ai_extraction, deal_tags, additional_charges,
       validation_flags, needs_review, extraction_confidence, bhk, carpet_area_sqft, built_up_area_sqft,
       area_raw_text, monthly_rent, price_raw_text, furnishing_status, created_at, updated_at)
    values
      (NEW.raw_message_id, NEW.tenant_id, coalesce(NEW.listing_index, 0), source_fp, 'residential', 'rent',
       NEW.building_name, NEW.location_raw, NEW.location_raw, NEW.micro_market, NEW.broker_name, NEW.broker_phone,
       NEW.summary_title, NEW.normalized_message, coalesce(NEW.raw_payload, '{}'), NEW.ai_extraction,
       coalesce(NEW.deal_tags, '{}'), coalesce(NEW.additional_charges, '[]'), coalesce(NEW.validation_flags, '[]'),
       review, confidence, public._typed_num(regexp_replace(NEW.bhk, '[^0-9.]', '', 'g')),
       coalesce(NEW.carpet_area_sqft, NEW.area_sqft), NEW.built_up_area_sqft, NEW.area, NEW.monthly_rent,
       NEW.ai_extraction->'price'->>'raw_price_text', NEW.furnishing_canonical, coalesce(NEW.created_at, now()), now())
    on conflict (source_fingerprint) do nothing;
  else
    insert into public.residential_sale_listings
      (raw_message_id, tenant_id, listing_index, source_fingerprint, asset_type, transaction_type,
       building_name, locality_raw, locality_resolved, micro_market, broker_name, broker_phone,
       summary_title, normalized_message, raw_payload, ai_extraction, deal_tags, additional_charges,
       validation_flags, needs_review, extraction_confidence, bhk, carpet_area_sqft, built_up_area_sqft,
       area_raw_text, total_asking_price, price_raw_text, furnishing_status, created_at, updated_at)
    values
      (NEW.raw_message_id, NEW.tenant_id, coalesce(NEW.listing_index, 0), source_fp, 'residential', 'sale',
       NEW.building_name, NEW.location_raw, NEW.location_raw, NEW.micro_market, NEW.broker_name, NEW.broker_phone,
       NEW.summary_title, NEW.normalized_message, coalesce(NEW.raw_payload, '{}'), NEW.ai_extraction,
       coalesce(NEW.deal_tags, '{}'), coalesce(NEW.additional_charges, '[]'), coalesce(NEW.validation_flags, '[]'),
       review, confidence, public._typed_num(regexp_replace(NEW.bhk, '[^0-9.]', '', 'g')),
       coalesce(NEW.carpet_area_sqft, NEW.area_sqft), NEW.built_up_area_sqft, NEW.area, NEW.total_asking_price,
       NEW.ai_extraction->'price'->>'raw_price_text', NEW.furnishing_canonical, coalesce(NEW.created_at, now()), now())
    on conflict (source_fingerprint) do nothing;
  end if;

  return NEW;
end;
$$;

create or replace function public._compat_forward_insert()
returns trigger
language plpgsql
as $$
declare
  payload jsonb := to_jsonb(NEW);
  target text := tg_argv[0];
begin
  if NEW.id is null then
    payload := jsonb_set(payload, '{id}', to_jsonb(nextval(pg_get_serial_sequence(target, 'id'))));
  end if;
  execute format('insert into %s overriding system value select (jsonb_populate_record(null::%s, $1)).*', target, target) using payload;
  return NEW;
end;
$$;

create or replace view public.parsed_output with (security_invoker=true) as select * from public.parsed_output_legacy;
create or replace view public.listings with (security_invoker=true) as select * from public.listings_legacy;
create or replace view public.market_requirements with (security_invoker=true) as select * from public.market_requirements_legacy;

drop trigger if exists parsed_output_insert_compat on public.parsed_output;
create trigger parsed_output_insert_compat
instead of insert on public.parsed_output
for each row execute function public._compat_insert_parsed_output();

drop trigger if exists listings_insert_compat on public.listings;
create trigger listings_insert_compat
instead of insert on public.listings
for each row execute function public._compat_forward_insert('public.listings_legacy');

drop trigger if exists market_requirements_insert_compat on public.market_requirements;
create trigger market_requirements_insert_compat
instead of insert on public.market_requirements
for each row execute function public._compat_forward_insert('public.market_requirements_legacy');

commit;
