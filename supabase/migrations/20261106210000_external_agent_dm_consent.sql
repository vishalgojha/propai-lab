-- Private WhatsApp DMs are a separate, opt-in capability for external agents.
-- Group evidence remains available through raw_messages:read. Existing keys
-- lose the DM scope until the workspace owner explicitly consents in Account.
alter table public.organizations
  add column if not exists external_agent_dms_enabled boolean not null default false,
  add column if not exists external_agent_dms_consented_at timestamptz,
  add column if not exists external_agent_dms_consented_by uuid references auth.users(id);

alter table public.external_agent_api_keys
  alter column scopes set default array[
    'inventory:read', 'requirements:read', 'matches:read', 'raw_messages:read'
  ];

update public.external_agent_api_keys
set scopes = array[
  'inventory:read', 'requirements:read', 'matches:read', 'raw_messages:read'
]
where 'raw_messages:dms' = any(scopes);
