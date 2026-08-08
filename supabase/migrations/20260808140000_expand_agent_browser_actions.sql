-- Agent Browser supports the full safe interaction set. High-risk workspace
-- writes still go through the separate confirmation flow.
alter table public.workspace_ai_settings
  alter column allowed_actions set default '["open","click","fill","type","select","scroll","screenshot","close"]'::jsonb;

update public.workspace_ai_settings
set allowed_actions = '["open","click","fill","type","select","scroll","screenshot","close"]'::jsonb
where allowed_actions = '["open", "click", "fill", "select", "scroll"]'::jsonb
   or allowed_actions = '["open","click","fill","select","scroll"]'::jsonb;
