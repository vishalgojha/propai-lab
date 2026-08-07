-- Enable the browser runtime for existing workspaces and make the new
-- provider the canonical value for all future rows.

alter table public.workspace_ai_settings
  alter column browser_provider set default 'agent-browser',
  alter column browser_enabled set default true;

alter table public.agent_browser_sessions
  alter column browser_provider set default 'agent-browser';

update public.workspace_ai_settings
set browser_provider = 'agent-browser'
where lower(coalesce(browser_provider, '')) in
  ('', 'browser-use', 'browser-use-cli', 'browser_use', 'playwright');

update public.agent_browser_sessions
set browser_provider = 'agent-browser'
where lower(coalesce(browser_provider, '')) in
  ('', 'browser-use', 'browser-use-cli', 'browser_use', 'playwright');

insert into public.workspace_ai_settings (
  tenant_id,
  browser_enabled,
  browser_provider,
  allowed_routes,
  allowed_actions
)
select
  o.id,
  true,
  'agent-browser',
  '["/chat", "/map", "/listings/*", "/brokers/*", "/admin/*"]'::jsonb,
  '["open", "click", "fill", "select", "scroll"]'::jsonb
from public.organizations o
where o.is_active = true
  and not exists (
    select 1
    from public.workspace_ai_settings s
    where s.tenant_id = o.id
  )
on conflict (tenant_id) do nothing;

-- Keep this automatic for every organization created after this migration.
-- The application should not need a separate settings step for a new broker.
create or replace function public.provision_workspace_ai_settings()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.workspace_ai_settings (
    tenant_id,
    browser_enabled,
    browser_provider,
    allowed_routes,
    allowed_actions
  ) values (
    new.id,
    true,
    'agent-browser',
    '["/chat", "/map", "/listings/*", "/brokers/*", "/admin/*"]'::jsonb,
    '["open", "click", "fill", "select", "scroll"]'::jsonb
  )
  on conflict (tenant_id) do nothing;
  return new;
end;
$$;

drop trigger if exists provision_workspace_ai_settings_on_organization
  on public.organizations;
create trigger provision_workspace_ai_settings_on_organization
after insert on public.organizations
for each row execute function public.provision_workspace_ai_settings();
