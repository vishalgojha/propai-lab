-- One-time, tenant-bound approvals for Hermes -> Social Flow mutations.

create table if not exists public.social_flow_approvals (
    nonce text primary key,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    user_id uuid not null references auth.users(id) on delete cascade,
    action text not null,
    params_hash text not null,
    status text not null default 'pending' check (status in ('pending', 'approved', 'expired', 'cancelled')),
    expires_at timestamptz not null,
    created_at timestamptz not null default now(),
    approved_at timestamptz
);

create index if not exists idx_social_flow_approvals_tenant_status
    on public.social_flow_approvals (tenant_id, status, created_at desc);

alter table public.social_flow_approvals enable row level security;

drop policy if exists "organization members can read social flow approvals" on public.social_flow_approvals;
create policy "organization members can read social flow approvals"
on public.social_flow_approvals for select to authenticated
using (
    user_id = (select auth.uid())
    and exists (
        select 1 from public.organization_members member
        where member.organization_id = social_flow_approvals.tenant_id
          and member.user_id = (select auth.uid())
          and member.is_active = true
    )
);
