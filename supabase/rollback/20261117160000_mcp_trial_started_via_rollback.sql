-- Rollback: drop the trial-start provenance marker column.
alter table public.organizations drop column if exists mcp_trial_started_via;
