-- Per-tenant durable preference memory for the chat agent.
-- A single 'workspace_ai' row replays what a broker has expressed across
-- chats (localities, size range, budget, BHK, intent) so future turns do not
-- re-ask what the workspace already knows. It lives on the tenant-scoped
-- requirement_match_preferences surface to reuse its row-level security and
-- per-tenant uniqueness contract.
alter table public.requirement_match_preferences
  drop constraint if exists requirement_match_preferences_requirement_type_check;
alter table public.requirement_match_preferences
  add constraint requirement_match_preferences_requirement_type_check
  check (requirement_type in ('residential_rent','residential_sale','commercial_rent','commercial_sale','workspace_ai'));

alter table public.requirement_match_preferences
  add column if not exists learned_preferences jsonb not null default '{}'::jsonb;

comment on column public.requirement_match_preferences.learned_preferences is
  'Durable constraints learned from chat turns for the workspace_ai preference row; ignored for matcher rows.';