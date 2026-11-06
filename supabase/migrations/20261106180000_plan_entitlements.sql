-- Product entitlements for the two PropAI plans.
-- MCP trials start lazily on the first authenticated MCP connection.
alter table public.organizations
  add column if not exists mcp_trial_started_at timestamptz,
  add column if not exists mcp_trial_ends_at timestamptz,
  add column if not exists self_chat_billing_exempt boolean not null default false,
  add column if not exists self_chat_billing_exempt_reason text not null default '';

create index if not exists idx_organizations_mcp_trial_ends
  on public.organizations(mcp_trial_ends_at)
  where mcp_trial_ends_at is not null;
