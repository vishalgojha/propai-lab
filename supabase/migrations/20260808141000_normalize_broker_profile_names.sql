-- Prefer a clean person/company name over phone numbers or extracted contact
-- phrases when setting the resolver's canonical broker profile name.
with counts as (
  select broker_id, btrim(broker_name) as broker_name, count(*) as occurrences
    from public.listings_unified
   where broker_id is not null
     and nullif(btrim(broker_name), '') is not null
     and btrim(broker_name) !~ '^[+0-9 ()-]{8,}$'
     and btrim(broker_name) !~* '\m(call|contact|whatsapp|feel free|kindly|on)\M'
   group by broker_id, btrim(broker_name)
), ranked as (
  select broker_id, broker_name,
         row_number() over (partition by broker_id order by occurrences desc, length(broker_name), broker_name) as rank
    from counts
)
update public.brokers b
   set canonical_name = ranked.broker_name,
       updated_at = now()
  from ranked
 where ranked.rank = 1
   and b.id = ranked.broker_id
   and (b.canonical_name is null or btrim(b.canonical_name) ~ '^[+0-9 ()-]{8,}$' or btrim(b.canonical_name) ~* '\m(call|contact|whatsapp|feel free|kindly|on)\M');
