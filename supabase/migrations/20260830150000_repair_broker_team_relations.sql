-- Make broker teams a real, evidence-backed relationship layer.
-- brokers remain atomic phone-linked identities; this migration never merges
-- or deletes broker rows. Team membership is proposed until an operator
-- confirms the source-backed relationship.

alter table public.broker_team_members
  add column if not exists membership_status text not null default 'proposed'
    check (membership_status in ('proposed', 'confirmed', 'rejected', 'expired'));

alter table public.broker_team_members
  add column if not exists primary_evidence_id bigint
    references public.broker_team_evidence(id) on delete set null;

alter table public.broker_team_members
  add column if not exists verified_at timestamptz;

create index if not exists idx_broker_team_members_broker
  on public.broker_team_members(broker_id);
create index if not exists idx_broker_team_members_status
  on public.broker_team_members(team_id, membership_status);

-- One broker can be proposed for several teams, but only once per team. This
-- is a relationship constraint, not an identity merge: brokers remain rows in
-- public.brokers with their own phones and aggregate data.

create or replace function public.rebuild_broker_team_intelligence()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
    team_rows integer := 0;
    member_rows integer := 0;
    evidence_rows integer := 0;
begin
    -- These are derived relationships. Rebuilding them is safe for broker
    -- identity because broker rows and raw evidence remain authoritative.
    delete from public.broker_teams;

    -- Recognise agency signatures including REALTOR/REALTORS variants. Keep
    -- the signature line-bounded and stop at the agency suffix: allowing an
    -- arbitrary suffix turns prose such as "all the above properties are"
    -- into a fake team and swallows the rest of a sentence.
    create temporary table _team_signatures on commit drop as
    select distinct r.id as raw_message_id,
           r.tenant_id,
           btrim(m[1]) as team_name,
           lower(regexp_replace(regexp_replace(btrim(m[1]), '\\brealtors?\\b', 'realtor', 'gi'), '[^a-z0-9]+', ' ', 'gi')) as normalized_name
    from public.raw_messages r
    cross join lateral regexp_matches(
        r.message,
        '(?mi)(?:^|[_*\r\n])\s*([A-Z][A-Z0-9 &.\-]{4,}?(?:REAL ESTATE|PROPERTIES|REALTY|REALTORS?|ESTATE)(?:[ &.\-]+(?:BANDRA|MUMBAI))?)\s*(?:[_*\r\n]|$)',
        'g'
    ) as x(m)
    where r.message is not null
      and upper(btrim(m[1])) !~ '^(ALL|FOR|THE|CONTACT|CALL|PROPERTY|THIS|ABOVE|AVAILABLE)';

    insert into public.broker_teams(tenant_id, canonical_name, normalized_name, confidence)
    select tenant_id, min(team_name), normalized_name, 0.92
    from _team_signatures
    where normalized_name <> ''
    group by tenant_id, normalized_name;
    get diagnostics team_rows = row_count;

    insert into public.broker_team_evidence(team_id, raw_message_id, evidence_type, evidence_text, confidence)
    select t.id, s.raw_message_id, 'agency_signature', s.team_name, 0.92
    from _team_signatures s
    join public.broker_teams t
      on t.tenant_id is not distinct from s.tenant_id
     and t.normalized_name = s.normalized_name
    on conflict (team_id, raw_message_id, evidence_type) do nothing;
    get diagnostics evidence_rows = row_count;

    -- A raw message with multiple distinct agency signatures is ambiguous:
    -- retain evidence, but do not cross-product every contact into every team.
    create temporary table _single_team_messages on commit drop as
    select raw_message_id, min(normalized_name) as normalized_name
    from _team_signatures
    group by raw_message_id
    having count(distinct normalized_name) = 1;

    with typed_contacts as (
        select raw_message_id, broker_id, broker_name, broker_phone from public.residential_sale_listings
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.residential_rent_listings
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.commercial_sale_listings
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.commercial_rent_listings
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.residential_sale_requirements
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.residential_rent_requirements
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.commercial_sale_requirements
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.commercial_rent_requirements
    ), candidates as (
        select distinct on (e.team_id, c.broker_id)
               e.team_id, c.broker_id,
               coalesce(nullif(c.broker_name, ''), b.canonical_name, '') as member_name,
               nullif(c.broker_phone, '') as member_phone,
               e.id as evidence_id,
               r.timestamp as observed_at
        from typed_contacts c
        join _single_team_messages s on s.raw_message_id = c.raw_message_id
        join public.broker_team_evidence e
          on e.raw_message_id = c.raw_message_id
         and e.team_id in (
             select t.id from public.broker_teams t
             join _team_signatures ts
               on ts.raw_message_id = c.raw_message_id
              and ts.normalized_name = t.normalized_name
              and t.tenant_id is not distinct from ts.tenant_id
         )
        join public.raw_messages r on r.id = c.raw_message_id
        left join public.brokers b on b.id = c.broker_id
        where c.broker_id is not null
          and coalesce(c.broker_name, c.broker_phone, '') <> ''
        order by e.team_id, c.broker_id, e.id
    )
    insert into public.broker_team_members(
        team_id, broker_id, member_name, member_phone, role, confidence,
        evidence_count, first_seen_at, last_seen_at, membership_status,
        primary_evidence_id
    )
    select team_id, broker_id, member_name, member_phone, 'member', 0.90,
           1, observed_at, observed_at, 'proposed', evidence_id
    from candidates
    on conflict (team_id, member_phone, member_name) do update
      set broker_id = coalesce(public.broker_team_members.broker_id, excluded.broker_id),
          confidence = greatest(public.broker_team_members.confidence, excluded.confidence),
          primary_evidence_id = coalesce(public.broker_team_members.primary_evidence_id, excluded.primary_evidence_id),
          last_seen_at = greatest(public.broker_team_members.last_seen_at, excluded.last_seen_at);
    get diagnostics member_rows = row_count;

    update public.broker_teams t
    set evidence_count = coalesce(s.evidence_count, 0),
        last_seen_at = s.last_seen_at,
        updated_at = now()
    from (
        select t2.id,
               count(distinct e.raw_message_id)::integer as evidence_count,
               max(r.timestamp) as last_seen_at
        from public.broker_teams t2
        left join public.broker_team_evidence e on e.team_id = t2.id
        left join public.raw_messages r on r.id = e.raw_message_id
        group by t2.id
    ) s
    where t.id = s.id;

    return jsonb_build_object('teams', team_rows, 'members', member_rows, 'evidence', evidence_rows);
end;
$$;

-- Rebuild the derived relationship tables using the corrected algorithm.
select public.rebuild_broker_team_intelligence();

create unique index if not exists idx_broker_team_members_team_broker
  on public.broker_team_members(team_id, broker_id)
  where broker_id is not null;

revoke all on function public.rebuild_broker_team_intelligence() from public, anon, authenticated;
grant execute on function public.rebuild_broker_team_intelligence() to service_role;
