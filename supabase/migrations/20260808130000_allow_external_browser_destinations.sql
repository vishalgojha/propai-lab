-- External browsing is explicitly permitted by the workspace browser policy.
-- The separate browser approval prompt remains required before navigation.

alter table public.workspace_ai_settings
  alter column allowed_routes set default '["*"]'::jsonb;

update public.workspace_ai_settings
set allowed_routes = '["*"]'::jsonb;

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
    '["*"]'::jsonb,
    '["open", "click", "fill", "select", "scroll"]'::jsonb
  )
  on conflict (tenant_id) do nothing;
  return new;
end;
$$;
