-- Typed read-model IDs are local to each typed table and can collide. Store
-- the discriminator with each typed ID; legacy IDs are compatibility fields.

alter table public.requirement_matches
  alter column requirement_id drop not null,
  alter column listing_id drop not null;

alter table public.requirement_matches
  drop constraint if exists requirement_matches_requirement_id_fkey,
  drop constraint if exists requirement_matches_listing_id_fkey,
  drop constraint if exists requirement_matches_requirement_id_listing_id_key;

alter table public.requirement_matches
  add column if not exists requirement_type text,
  add column if not exists requirement_typed_id bigint,
  add column if not exists listing_type text,
  add column if not exists listing_typed_id bigint;

create unique index if not exists requirement_matches_typed_pair_key
  on public.requirement_matches (
    tenant_id, requirement_type, requirement_typed_id,
    listing_type, listing_typed_id
  );

create index if not exists requirement_matches_typed_requirement_idx
  on public.requirement_matches (tenant_id, requirement_type, requirement_typed_id, match_score desc);
