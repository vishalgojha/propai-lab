-- Keep existing group-control rows attached to the confirmed PropAI tenant
-- after repairing org_whatsapp_connections for the internal connection.
update public.organization_group_connections
   set organization_id = '00000000-0000-0000-0000-000000000010',
       updated_at = now()
 where whatsapp_connection_id = 33
   and organization_id = 'b841327d-081c-4632-932e-8fba73b2061a';
