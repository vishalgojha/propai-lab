-- Interactive onboarding group novelty audit and hard three-group cap.

alter table public.org_whatsapp_connections
  add column if not exists group_audit_required boolean not null default true,
  add column if not exists group_audit_completed_at timestamptz;

create index if not exists idx_org_whatsapp_connections_group_audit
  on public.org_whatsapp_connections (organization_id, group_audit_required, is_active);

-- The confirmed PropAI-owned WhatsApp login belongs to the default PropAI
-- Workspace tenant. Repair the stale duplicate organization linkage so the
-- internal connection is excluded by data as well as by the runtime guard.
update public.org_whatsapp_connections
   set organization_id = '00000000-0000-0000-0000-000000000010',
       updated_at = now()
 where broker_id = 'phone-54ee9be74224';

update public.team_members
   set organization_id = '00000000-0000-0000-0000-000000000010',
       updated_at = now()
 where lower(email) = 'vishal@chaoscraftlabs.com';

update public.user_profiles
   set tenant_id = '00000000-0000-0000-0000-000000000010',
       updated_at = now()
 where lower(email) = 'vishal@chaoscraftlabs.com';

comment on column public.org_whatsapp_connections.group_audit_required is
  'Broker must confirm the interactive novelty-ranked group selection before extraction; PropAI internal connection is exempt.';

comment on column public.org_whatsapp_connections.group_audit_completed_at is
  'Timestamp of the last confirmed group selection for this WhatsApp connection.';
