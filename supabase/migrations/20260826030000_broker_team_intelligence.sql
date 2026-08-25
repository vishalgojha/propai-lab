-- Broker/team intelligence is a grouping layer, not a broker identity merge.
create table if not exists public.broker_teams (
    id bigint generated always as identity primary key,
    tenant_id uuid references public.organizations(id) on delete cascade,
    canonical_name text not null,
    normalized_name text not null,
    confidence numeric(6,5) not null default 0,
    evidence_count integer not null default 0,
    listing_count integer not null default 0,
    requirement_count integer not null default 0,
    market_count integer not null default 0,
    building_count integer not null default 0,
    first_seen_at timestamptz,
    last_seen_at timestamptz,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (tenant_id, normalized_name)
);

create table if not exists public.broker_team_members (
    id bigint generated always as identity primary key,
    team_id bigint not null references public.broker_teams(id) on delete cascade,
    broker_id bigint references public.brokers(id) on delete set null,
    member_name text not null default '',
    member_phone text,
    role text not null default 'member',
    confidence numeric(6,5) not null default 0,
    evidence_count integer not null default 0,
    first_seen_at timestamptz,
    last_seen_at timestamptz,
    unique (team_id, member_phone, member_name)
);

create table if not exists public.broker_team_evidence (
    id bigint generated always as identity primary key,
    team_id bigint not null references public.broker_teams(id) on delete cascade,
    raw_message_id bigint not null references public.raw_messages(id) on delete cascade,
    evidence_type text not null,
    evidence_text text not null default '',
    confidence numeric(6,5) not null default 0,
    created_at timestamptz not null default now(),
    unique (team_id, raw_message_id, evidence_type)
);

create index if not exists idx_broker_teams_tenant_name
  on public.broker_teams(tenant_id, normalized_name);
create index if not exists idx_broker_team_members_team
  on public.broker_team_members(team_id);
create index if not exists idx_broker_team_members_phone
  on public.broker_team_members(member_phone);
create index if not exists idx_broker_team_evidence_message
  on public.broker_team_evidence(raw_message_id);

alter table public.broker_teams enable row level security;
alter table public.broker_team_members enable row level security;
alter table public.broker_team_evidence enable row level security;

create policy "service role manages broker teams" on public.broker_teams
  for all to service_role using (true) with check (true);
create policy "service role manages broker team members" on public.broker_team_members
  for all to service_role using (true) with check (true);
create policy "service role manages broker team evidence" on public.broker_team_evidence
  for all to service_role using (true) with check (true);

-- Rebuild inferred agency/team clusters from source signatures. This never
-- merges broker contacts; it only links contacts that co-occur with the same
-- explicit agency signature in source evidence.
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
    delete from public.broker_teams;

    with signatures as (
        select distinct r.tenant_id,
               btrim(m[1]) as team_name,
               lower(regexp_replace(btrim(m[1]), '[^a-z0-9]+', ' ', 'gi')) as normalized_name
        from public.raw_messages r
        cross join lateral regexp_matches(
            r.message,
            '(?mi)(?:^|[_*])\s*([A-Z][A-Z0-9 &.-]{4,}(?:REAL ESTATE|PROPERTIES|REALTY|ESTATE))\s*(?:[_*]|$)',
            'g'
        ) as x(m)
        where r.message is not null
    )
    insert into public.broker_teams(tenant_id, canonical_name, normalized_name, confidence)
    select tenant_id, min(team_name), normalized_name, 0.92
    from signatures
    where normalized_name <> ''
    group by tenant_id, normalized_name
    on conflict (tenant_id, normalized_name) do update
      set canonical_name = excluded.canonical_name,
          confidence = greatest(public.broker_teams.confidence, excluded.confidence),
          updated_at = now();

    get diagnostics team_rows = row_count;

    insert into public.broker_team_evidence(team_id, raw_message_id, evidence_type, evidence_text, confidence)
    select t.id, r.id, 'agency_signature', t.canonical_name, 0.92
    from public.raw_messages r
    join public.broker_teams t on t.tenant_id is not distinct from r.tenant_id
    cross join lateral regexp_matches(
        r.message,
        '(?mi)(?:^|[_*])\s*([A-Z][A-Z0-9 &.-]{4,}(?:REAL ESTATE|PROPERTIES|REALTY|ESTATE))\s*(?:[_*]|$)',
        'g'
    ) as x(m)
    where lower(regexp_replace(btrim(x.m[1]), '[^a-z0-9]+', ' ', 'gi')) = t.normalized_name
    on conflict (team_id, raw_message_id, evidence_type) do nothing;
    get diagnostics evidence_rows = row_count;

    with typed_contacts as (
        select raw_message_id, broker_id, broker_name, broker_phone from public.residential_sale_listings
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.residential_rent_listings
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.commercial_sale_listings
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.commercial_rent_listings
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.residential_sale_requirements
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.residential_rent_requirements
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.commercial_sale_requirements
        union all select raw_message_id, broker_id, broker_name, broker_phone from public.commercial_rent_requirements
    )
    insert into public.broker_team_members(team_id, broker_id, member_name, member_phone, confidence, evidence_count)
    select distinct e.team_id, c.broker_id, coalesce(nullif(c.broker_name, ''), b.canonical_name),
           nullif(c.broker_phone, ''), 0.90, 1
    from public.broker_team_evidence e
    join typed_contacts c on c.raw_message_id = e.raw_message_id
    left join public.brokers b on b.id = c.broker_id
    where coalesce(c.broker_name, c.broker_phone, '') <> ''
    on conflict (team_id, member_phone, member_name) do update
      set evidence_count = public.broker_team_members.evidence_count + 1,
          confidence = greatest(public.broker_team_members.confidence, excluded.confidence);
    get diagnostics member_rows = row_count;

    update public.broker_teams t
    set evidence_count = coalesce(s.evidence_count, 0),
        listing_count = coalesce(s.listing_count, 0),
        requirement_count = coalesce(s.requirement_count, 0),
        last_seen_at = s.last_seen_at,
        updated_at = now()
    from (
        select t2.id, count(distinct e.raw_message_id)::integer evidence_count,
               count(distinct case when r.message_type in ('SELLER','RENTAL','COMMERCIAL_SALE','COMMERCIAL_RENTAL','PRE_LAUNCH') then e.raw_message_id end)::integer listing_count,
               count(distinct case when r.message_type in ('REQUIREMENT','RENTAL_SEEKER') then e.raw_message_id end)::integer requirement_count,
               max(r.timestamp) last_seen_at
        from public.broker_teams t2
        left join public.broker_team_evidence e on e.team_id = t2.id
        left join public.raw_messages r on r.id = e.raw_message_id
        group by t2.id
    ) s
    where t.id = s.id;

    with typed_opportunities as (
        select raw_message_id, 'listing'::text as role from public.residential_sale_listings
        union all select raw_message_id, 'listing' from public.residential_rent_listings
        union all select raw_message_id, 'listing' from public.commercial_sale_listings
        union all select raw_message_id, 'listing' from public.commercial_rent_listings
        union all select raw_message_id, 'requirement' from public.residential_sale_requirements
        union all select raw_message_id, 'requirement' from public.residential_rent_requirements
        union all select raw_message_id, 'requirement' from public.commercial_sale_requirements
        union all select raw_message_id, 'requirement' from public.commercial_rent_requirements
    ), counts as (
        select e.team_id,
               count(distinct case when o.role = 'listing' then o.raw_message_id end)::integer as listing_count,
               count(distinct case when o.role = 'requirement' then o.raw_message_id end)::integer as requirement_count
        from public.broker_team_evidence e
        join typed_opportunities o on o.raw_message_id = e.raw_message_id
        group by e.team_id
    )
    update public.broker_teams t
    set listing_count = c.listing_count,
        requirement_count = c.requirement_count,
        updated_at = now()
    from counts c
    where t.id = c.team_id;

    return jsonb_build_object('teams', team_rows, 'members', member_rows, 'evidence', evidence_rows);
end;
$$;
