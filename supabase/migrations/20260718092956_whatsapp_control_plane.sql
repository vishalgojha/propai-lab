-- WhatsApp control-plane settings are stored with the connection so both the
-- API and the self-chat webhook make the same authorization decision.
alter table public.org_whatsapp_connections
    add column if not exists self_chat_enabled boolean not null default true,
    add column if not exists updated_at timestamptz not null default now();

-- Older auto-created workspaces pre-date role assignment. Give the first
-- active member owner access and subsequent unassigned members broker access.
with ranked_members as (
    select
        om.id,
        om.organization_id,
        row_number() over (
            partition by om.organization_id
            order by om.created_at asc, om.id asc
        ) as member_rank
    from public.organization_members om
    where om.is_active = true and om.role_id is null
), system_roles as (
    select
        max(id) filter (where slug = 'owner') as owner_role_id,
        max(id) filter (where slug = 'broker') as broker_role_id
    from public.roles
    where organization_id is null and slug in ('owner', 'broker')
), organizations_with_owner as (
    select distinct om.organization_id
    from public.organization_members om
    join public.roles r on r.id = om.role_id
    where om.is_active = true and r.slug = 'owner'
)
update public.organization_members om
set role_id = case
    when existing_owner.organization_id is null and ranked_members.member_rank = 1
        then coalesce(system_roles.owner_role_id, system_roles.broker_role_id)
    else coalesce(system_roles.broker_role_id, system_roles.owner_role_id)
end
from ranked_members
cross join system_roles
left join organizations_with_owner existing_owner
    on existing_owner.organization_id = ranked_members.organization_id
where om.id = ranked_members.id
  and coalesce(system_roles.owner_role_id, system_roles.broker_role_id) is not null;

-- Access rows are configuration records, so removing a member should remove
-- their phone rules instead of blocking member deletion.
alter table public.team_member_whatsapp_access
    drop constraint if exists team_member_whatsapp_access_team_member_id_fkey,
    add constraint team_member_whatsapp_access_team_member_id_fkey
        foreign key (team_member_id) references public.team_members(id) on delete cascade;

alter table public.team_member_whatsapp_access enable row level security;

drop policy if exists "Service role has full access to team member WhatsApp access"
    on public.team_member_whatsapp_access;
create policy "Service role has full access to team member WhatsApp access"
    on public.team_member_whatsapp_access
    for all
    to service_role
    using (true)
    with check (true);
