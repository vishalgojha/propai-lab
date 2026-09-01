# Phase 4 — pg_net Security Compensating Control

Date: 2026-09-01

## Finding

Supabase Advisor reported `pg_net` installed in the `public` schema. The live
extension catalog reports version `0.20.4` and `extrelocatable=false`, so the
extension cannot safely be moved with `ALTER EXTENSION ... SET SCHEMA`.

## Investigation and attempted mitigation

- Confirmed the repository has no application calls to `net.http_*`,
  `net.wake`, or worker-control functions.
- Attempted explicit and schema-wide execution revocation from `public`,
  `anon`, and `authenticated` for all 12 exposed `net` functions.
- The migration API returned success, but the live ACL remained
  `{=X/supabase_admin,supabase_admin=X/supabase_admin}` for every function.
- Live verification still reports all 12 functions executable by `anon`,
  `authenticated`, and `service_role`.

## Production verification

Both migrations were applied to production. Live verification shows that
Supabase-managed `pg_net` ACLs are restored/immutable from this migration
path. The extension-placement Advisor warning remains, and the function
execution grants could not be changed through the available migration role.

The extension owns `net.http_request_queue` and `net._http_response`; the
current live counts are 0 queued requests and 2 stored responses. Dropping and
recreating the extension to relocate it would be a destructive operation and
was intentionally not attempted.

Status: **blocked pending a Supabase-supported pg_net privilege/relocation
procedure**.

## Coolify redeployment

No Coolify redeploy is required. This is a Supabase function-grant migration.
