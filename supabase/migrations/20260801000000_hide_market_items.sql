create table if not exists public.hidden_market_items (
    hidden_key text primary key,
    tenant_id uuid,
    item_kind text not null check (item_kind in ('listing', 'requirement')),
    listing_id bigint,
    raw_message_id bigint,
    broker_phone text,
    broker_name text,
    source_label text,
    hidden_reason text,
    hidden_by uuid,
    hidden_at timestamptz not null default now()
);

create index if not exists idx_hidden_market_items_tenant_kind
    on public.hidden_market_items (tenant_id, item_kind, hidden_at desc);

create index if not exists idx_hidden_market_items_listing_id
    on public.hidden_market_items (listing_id)
    where listing_id is not null;

create index if not exists idx_hidden_market_items_raw_message_id
    on public.hidden_market_items (raw_message_id)
    where raw_message_id is not null;

create index if not exists idx_hidden_market_items_broker_phone
    on public.hidden_market_items (broker_phone)
    where broker_phone is not null and broker_phone <> '';

alter table public.hidden_market_items enable row level security;

grant select, insert, update, delete on table public.hidden_market_items to service_role;
