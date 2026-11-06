-- Instinct may inspect the source evidence behind normalized inventory.
-- Groups are covered by raw_messages:read; private DMs require the separate
-- raw_messages:dms scope so the boundary is explicit in every request.
alter table public.external_agent_api_keys
  alter column scopes set default array[
    'inventory:read', 'requirements:read', 'matches:read',
    'raw_messages:read', 'raw_messages:dms'
  ];

update public.external_agent_api_keys
set scopes = array[
  'inventory:read', 'requirements:read', 'matches:read',
  'raw_messages:read', 'raw_messages:dms'
]
where lower(label) = 'instinct';
