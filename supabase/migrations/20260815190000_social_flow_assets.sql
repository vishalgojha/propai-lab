-- Private creative assets uploaded for the tenant's Meta Ads workspace.
-- Bytes live in the existing private whatsapp-media bucket; this table keeps
-- only tenant-scoped metadata and the storage key.

create table if not exists public.social_flow_assets (
    id bigint generated always as identity primary key,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    storage_path text not null unique,
    filename text not null,
    mime_type text not null,
    size_bytes bigint not null,
    asset_kind text not null check (asset_kind in ('image', 'video', 'document')),
    created_by uuid references auth.users(id) on delete set null,
    created_at timestamptz not null default now()
);

create index if not exists idx_social_flow_assets_tenant_created
    on public.social_flow_assets (tenant_id, created_at desc);

alter table public.social_flow_assets enable row level security;

drop policy if exists "organization members can read social flow assets" on public.social_flow_assets;
create policy "organization members can read social flow assets"
on public.social_flow_assets for select to authenticated
using (exists (
    select 1 from public.organization_members member
    where member.organization_id = social_flow_assets.tenant_id
      and member.user_id = (select auth.uid())
      and member.is_active = true
));
