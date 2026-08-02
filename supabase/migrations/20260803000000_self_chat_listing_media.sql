-- Self-chat property-photo drafts.  Photos are uploaded by the WhatsApp
-- ingestor to the private whatsapp-media bucket and are only attached to a
-- listing after the user explicitly confirms the draft.

create table if not exists public.listing_media_drafts (
    id bigint generated always as identity primary key,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    broker_phone text not null,
    session_key text not null,
    status text not null default 'collecting'
        check (status in ('collecting', 'awaiting_confirmation', 'published', 'discarded')),
    listing_id bigint references public.listings(id) on delete set null,
    details jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (tenant_id, broker_phone, session_key)
);

create table if not exists public.listing_media_draft_items (
    id bigint generated always as identity primary key,
    draft_id bigint not null references public.listing_media_drafts(id) on delete cascade,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    storage_path text not null,
    media_id text not null default '',
    filename text not null default '',
    mime_type text not null default 'image/jpeg',
    file_length bigint,
    caption text not null default '',
    source_message_id text not null default '',
    created_at timestamptz not null default now(),
    unique (draft_id, storage_path)
);

alter table public.listing_photos add column if not exists storage_path text not null default '';
alter table public.listing_photos add column if not exists source_message_id text not null default '';

create index if not exists idx_listing_media_drafts_tenant_session
    on public.listing_media_drafts (tenant_id, broker_phone, session_key);
create index if not exists idx_listing_media_draft_items_draft
    on public.listing_media_draft_items (tenant_id, draft_id, created_at);

alter table public.listing_media_drafts enable row level security;
alter table public.listing_media_draft_items enable row level security;

drop policy if exists "organization members can read listing media drafts" on public.listing_media_drafts;
create policy "organization members can read listing media drafts"
on public.listing_media_drafts for select to authenticated
using (exists (
    select 1 from public.organization_members member
    where member.organization_id = listing_media_drafts.tenant_id
      and member.user_id = (select auth.uid())
      and member.is_active = true
));

drop policy if exists "organization members can read listing media draft items" on public.listing_media_draft_items;
create policy "organization members can read listing media draft items"
on public.listing_media_draft_items for select to authenticated
using (exists (
    select 1 from public.organization_members member
    where member.organization_id = listing_media_draft_items.tenant_id
      and member.user_id = (select auth.uid())
      and member.is_active = true
));
