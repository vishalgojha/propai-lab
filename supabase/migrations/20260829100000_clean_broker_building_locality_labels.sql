-- Remove locality/preference/corridor labels that were incorrectly materialized
-- into broker_building_stats. Operating-area counts remain in broker_market_stats.
with known(label) as (
    select lower(trim(sub_locality)) from locality_reference where nullif(trim(sub_locality), '') is not null
    union
    select lower(trim(parent_locality)) from locality_reference where nullif(trim(parent_locality), '') is not null
    union all values
      ('bandra'), ('bandra east'), ('bandra west'), ('khar'), ('khar west'),
      ('santacruz'), ('santacruz east'), ('santacruz west'), ('andheri'),
      ('andheri east'), ('andheri west'), ('bkc'), ('juhu'), ('powai'),
      ('worli'), ('lower parel'), ('pali hill'), ('pali naka'), ('mahim')
), candidates as (
    select id, building_name,
           regexp_replace(
             regexp_replace(lower(trim(building_name)), '\s+(preferred|options?|localities?)$', '', 'i'),
             '\s*(/|\mto\M|[-–—])\s*', '|', 'g'
           ) as normalized
    from broker_building_stats
    where nullif(trim(building_name), '') is not null
), polluted as (
    select c.id
    from candidates c
    where exists (
        select 1 from known k
        where regexp_replace(c.normalized, '[^a-z0-9]+', '', 'g') = regexp_replace(k.label, '[^a-z0-9]+', '', 'g')
    )
    or (
        c.normalized like '%|%'
        and not exists (
            select 1
            from regexp_split_to_table(c.normalized, '\|') part
            where nullif(trim(part), '') is not null
              and not exists (
                  select 1 from known k
                  where regexp_replace(trim(part), '[^a-z0-9]+', '', 'g') = regexp_replace(k.label, '[^a-z0-9]+', '', 'g')
              )
        )
    )
)
delete from broker_building_stats b
using polluted p
where b.id = p.id;

update brokers b
set building_count = (
    select count(*) from broker_building_stats s where s.broker_id = b.id
);
