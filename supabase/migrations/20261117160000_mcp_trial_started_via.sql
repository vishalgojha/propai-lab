-- Provenance for the assistant trial clock. Only rows written by the
-- first-successful-assistant-search path carry this marker; every
-- pre-existing row keeps NULL, which readers must treat as UNKNOWN
-- provenance - never as a recorded first search and never as a new clock.
alter table public.organizations add column if not exists mcp_trial_started_via text;
