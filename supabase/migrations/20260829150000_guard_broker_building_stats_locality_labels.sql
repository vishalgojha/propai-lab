-- Keep the broker directory's building aggregate aligned with the
-- conservative Python building-name validator.  The broker graph is rebuilt
-- from typed tables in SQL, so it must not materialize locality/market
-- segment labels as buildings.

create or replace function public.broker_building_stats_skip_locality_label()
returns trigger
language plpgsql
security invoker
set search_path = public, extensions
as $$
declare
    candidate text := regexp_replace(lower(trim(new.building_name)), '\s+', ' ', 'g');
    without_suffix text;
    part text;
    known boolean;
    all_known boolean := true;
begin
    if nullif(candidate, '') is null then
        return null;
    end if;

    -- These are message/inventory labels, never physical building names.
    if candidate ~* '^(preferred|please\s+share\s+matching\s+options|vegetarian\s+preferred|kitchen\s+cabinets\s+preferred)$'
       or candidate ~* '^building\s*:\s*new\s+preferred$' then
        return null;
    end if;

    -- Strip broker market-segment suffixes before checking each locality.
    without_suffix := regexp_replace(candidate, '\s+(preferred|options?|localities?)$', '', 'i');
    without_suffix := regexp_replace(without_suffix, '\s*(/|\mto\M|\mand\M|[-–—])\s*', '|', 'g');

    -- A single locality label, or a slash/to/dash joined set of locality
    -- labels, is operating-area metadata rather than a physical building.
    if without_suffix like '%|%' then
        for part in select regexp_split_to_table(without_suffix, '\|') loop
            if nullif(trim(part), '') is null then
                continue;
            end if;
            select exists (
                select 1
                from locality_reference lr
                where regexp_replace(lower(trim(coalesce(lr.sub_locality, ''))), '[^a-z0-9]+', '', 'g') = regexp_replace(trim(part), '[^a-z0-9]+', '', 'g')
                   or regexp_replace(lower(trim(coalesce(lr.parent_locality, ''))), '[^a-z0-9]+', '', 'g') = regexp_replace(trim(part), '[^a-z0-9]+', '', 'g')
                   or trim(part) ~* '^(near\s+)?(bandra|khar|santacruz|andheri|ndheri|juhu|powai|worli|lower\s+parel|pali\s+hill|peddar\s+road|mahim|malabar\s+hill|chembur|thane|mulund|goregaon|malad|vikhroli|ghatkopar|bkc|navi\s+mumbai|matunga|dadar|vile\s+parle)(\s+(east|west|naka|road|hill|east\s+west))?$'
            ) into known;
            if not known then
                all_known := false;
                exit;
            end if;
        end loop;
        if all_known then
            return null;
        end if;
    else
        select exists (
            select 1
            from locality_reference lr
            where regexp_replace(lower(trim(coalesce(lr.sub_locality, ''))), '[^a-z0-9]+', '', 'g') = regexp_replace(without_suffix, '[^a-z0-9]+', '', 'g')
               or regexp_replace(lower(trim(coalesce(lr.parent_locality, ''))), '[^a-z0-9]+', '', 'g') = regexp_replace(without_suffix, '[^a-z0-9]+', '', 'g')
        ) into known;
        if known then
            return null;
        end if;
    end if;

    -- Keep the explicit Mumbai labels covered even if the locality reference
    -- table is later curated or temporarily incomplete.
    if without_suffix ~* '^(near\s+)?(bandra|khar|santacruz|andheri|ndheri|juhu|powai|worli|lower\s+parel|pali\s+hill|peddar\s+road|mahim|malabar\s+hill|chembur|thane|mulund|goregaon|malad|vikhroli|ghatkopar|bkc|navi\s+mumbai|matunga|dadar|vile\s+parle)(\s+(east|west|naka|road|hill|east\s+west))?$' then
        return null;
    end if;

    return new;
end;
$$;

drop trigger if exists broker_building_stats_locality_guard on public.broker_building_stats;
create trigger broker_building_stats_locality_guard
before insert or update of building_name on public.broker_building_stats
for each row execute function public.broker_building_stats_skip_locality_label();

revoke execute on function public.broker_building_stats_skip_locality_label()
    from public, anon, authenticated;
grant execute on function public.broker_building_stats_skip_locality_label()
    to service_role;

create or replace function public.refresh_broker_building_counts()
returns trigger
language plpgsql
security invoker
set search_path = public, extensions
as $$
begin
    update public.brokers b
       set building_count = (
           select count(*) from public.broker_building_stats s
           where s.broker_id = b.id
       );
    return null;
end;
$$;

drop trigger if exists broker_building_stats_refresh_counts on public.broker_building_stats;
create trigger broker_building_stats_refresh_counts
after insert on public.broker_building_stats
for each statement execute function public.refresh_broker_building_counts();

revoke execute on function public.refresh_broker_building_counts()
    from public, anon, authenticated;
grant execute on function public.refresh_broker_building_counts()
    to service_role;

-- Backfill the already-materialized derived table. Rebuild afterwards so the
-- broker building counts and rows are regenerated from the guarded source.
with known(label) as (
    select lower(trim(sub_locality)) from public.locality_reference where nullif(trim(sub_locality), '') is not null
    union
    select lower(trim(parent_locality)) from public.locality_reference where nullif(trim(parent_locality), '') is not null
    union all values
      ('bandra'), ('bandra east'), ('bandra west'), ('khar'), ('khar west'),
      ('santacruz'), ('santacruz east'), ('santacruz west'), ('andheri'),
      ('andheri east'), ('andheri west'), ('bkc'), ('juhu'), ('powai'),
      ('worli'), ('lower parel'), ('pali hill'), ('pali naka'), ('mahim')
), candidates as (
    select id,
           regexp_replace(
             regexp_replace(lower(trim(building_name)), '\s+(preferred|options?|localities?)$', '', 'i'),
             '\s*(/|\mto\M|\mand\M|[-–—])\s*', '|', 'g'
           ) as normalized
    from public.broker_building_stats
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
                     or trim(part) ~* '^(near\s+)?(bandra|khar|santacruz|andheri|ndheri|juhu|powai|worli|lower\s+parel|pali\s+hill|peddar\s+road|mahim|malabar\s+hill|chembur|thane|mulund|goregaon|malad|vikhroli|ghatkopar|bkc|navi\s+mumbai|matunga|dadar|vile\s+parle)(\s+(east|west|naka|road|hill|east\s+west))?$'
              )
        )
    )
)
delete from public.broker_building_stats b
using polluted p
where b.id = p.id;

delete from public.broker_building_stats b
where lower(trim(b.building_name)) ~* '^(preferred|please\s+share\s+matching\s+options|vegetarian\s+preferred|kitchen\s+cabinets\s+preferred)$'
   or lower(trim(b.building_name)) ~* '^building\s*:\s*new\s+preferred$';

select public.rebuild_broker_graph();

comment on function public.broker_building_stats_skip_locality_label() is
  'Prevents locality and broker market-segment labels from entering broker_building_stats during SQL graph rebuilds.';
