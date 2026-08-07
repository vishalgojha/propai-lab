-- Recover explicit broker names when older rows stored only the phone number.
-- This is intentionally conservative: only names following call/contact
-- language and preceding an on/at phone marker are promoted.

do $$
declare
  t text;
begin
  foreach t in array array[
    'residential_sale_listings', 'residential_rent_listings',
    'commercial_sale_listings', 'commercial_rent_listings'
  ] loop
    execute format($sql$
      with candidates as (
        select l.id,
               l.broker_id,
               nullif(
                 btrim((regexp_match(
                   rm.message,
                   $re$(?i)(?:kindly[[:space:]]+)?(?:call|contact|speak[[:space:]]+to|reach)[[:space:]]+[*_" ]*([A-Za-z][A-Za-z .-]{1,60})[*_" ]*[[:space:]]+(?:on|at)[[:space:]]+[+0-9]$re$
                 ))[1], ' *_".,:;'),
                 ''
               ) as broker_name
          from public.%I l
          join public.raw_messages rm on rm.id = l.raw_message_id
         where nullif(btrim(l.broker_name), '') is null
            or btrim(l.broker_name) ~ '^[+0-9 ()-]{8,}$'
      )
      update public.%I l
         set broker_name = c.broker_name
        from candidates c
       where l.id = c.id
         and c.broker_name is not null
    $sql$, t, t);
  end loop;
end;
$$;

-- Keep the broker resolver consistent with the listing rows where a broker
-- profile was previously created under its phone number.
with names as (
  select l.broker_id,
         max(nullif(btrim(l.broker_name), '')) as broker_name
    from public.listings_unified l
   where l.broker_id is not null
     and nullif(btrim(l.broker_name), '') is not null
     and btrim(l.broker_name) !~ '^[+0-9 ()-]{8,}$'
   group by l.broker_id
)
update public.brokers b
   set canonical_name = names.broker_name,
       updated_at = now()
  from names
 where b.id = names.broker_id
   and (b.canonical_name is null or btrim(b.canonical_name) ~ '^[+0-9 ()-]{8,}$');
