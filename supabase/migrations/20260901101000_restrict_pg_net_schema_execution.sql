-- Attempted Phase 4 compensating control for the managed pg_net extension.
-- Supabase-managed ACLs may restore the extension's default PUBLIC grants;
-- retain this migration as the recorded, non-destructive attempt.
revoke execute on all functions in schema net from public, anon, authenticated;
grant execute on all functions in schema net to service_role;
