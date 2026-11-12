-- Expand existing Instinct keys with the read-only tools. Private CRM writes
-- remain opt-in and are not granted by this migration.
update public.external_agent_api_keys
set scopes = (
  select array_agg(distinct scope order by scope)
  from unnest(
    coalesce(scopes, '{}'::text[])
    || array['standing_searches:read', 'automatch:read', 'workspace:attention', 'followups:read']::text[]
  ) as scope
)
where revoked_at is null;
