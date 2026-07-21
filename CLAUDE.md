@AGENTS.md

<!-- BEGIN:session-handoff (last updated 2026-07-19) -->
# Session Handoff — PropAI tenant-isolation + www hardening

## STATUS (2026-07-19): Tier-2 tenant isolation IN PROGRESS — PAUSED FOR USER REVIEW
Committed: migration `supabase/migrations/20260719000000_tenant_isolation_tier2.sql`
+ `tests/test_tenant_isolation_tier2.py` (commit `b192827`).

### NOT YET COMMITTED (code edits done, mixed with pre-existing dirty changes in app.py)
`app.py` and `storage/supabase.py` have the tenant guards applied but are NOT committed
because `app.py` was already dirty (pre-existing `load_excluded_groups` opt-out refactor
in `get_groups`/audit pages). DO NOT `git add app.py storage/supabase.py` blindly —
those carry unrelated uncommitted work. Stage only the tenant-isolation hunks if committing.

### What the code changes do (review before deploy)
- storage/supabase.py: added `tenant_id` to all reads/writes of
  ai_chat_sessions, ai_chat_messages, user_profiles, saved_inbox_views, llm_providers.
  Also CREATED the missing storage methods create_saved_inbox_view / update_saved_inbox_view /
  delete_saved_inbox_view / get_saved_inbox_view (endpoints called undefined methods → were 500ing).
- app.py: all 5 table families' endpoints now depend on `get_tenant_context` and pass
  tenant_id into storage. llm_providers endpoints also tenant-scoped (credential exposure fix).
- tests/test_tenant_isolation_tier2.py: endpoint-forwarding + storage-scoping tests.
  Storage-level test passes standalone. Endpoint tests need full project env (import app → fastapi chain).

### CRITICAL LIVE-DB FINDINGS (verify before applying migration)
- `ai_chat_sessions` / `ai_chat_messages` tables DO NOT EXIST in live project
  (jsoiuzfwohtfkctlkozw) — migration `20260714000000_add_chat_sessions.sql` was never applied here.
  The Tier2 migration `create table if not exists` handles this safely.
- `saved_inbox_views` ALREADY has `tenant_id` (prior multi-tenant migration ran); migration's
  `add column if not exists` is a safe no-op there.
- `user_profiles`, `llm_providers` had NO tenant_id → migration adds it.
- `get_tenant_context` (app.py:2961) validates X-Tenant-Id against user's orgs — good.
- App uses service_role key → BYPASSES RLS, so RLS policies are defense-in-depth only
  (don't break runtime). Matches existing pattern from 20260709000000.

### TO APPLY THE MIGRATION (user action)
Option A — Supabase dashboard SQL Editor: paste file
`supabase/migrations/20260719000000_tenant_isolation_tier2.sql`, Run.
Option B — `supabase db push` (needs CLI + DB password).
Then: review + commit app.py/storage/supabase.py tenant hunks, redeploy backend via Coolify Force Deploy.

### DEFAULT TENANT
`00000000-0000-0000-0000-000000000010` = "PropAI Workspace" (legacy backfill target).
`b841327d-081c-4632-932e-8fba73b2061a` = "vishal" (live org; listings already there).

### SECURITY POSTURE
Cross-tenant gaps closed by this work: per-user chat history (PII), user_profiles (PII),
saved_inbox_views, llm_providers (plaintext API keys: sk-…, nvapi-…). After deploy +
verification, broker onboarding (currently paused) can resume.

### ENV / TOOLING NOTES
- venv `/tmp/opencode/venv` has: supabase, requests, pillow, numpy, pytest, fastapi, pydantic.
  NOT a full project env → `import app` fails (needs whole dep tree); run storage tests standalone.
- www env needs `DOUBLEWORD_API_URL` + `DOUBLEWORD_API_KEY` in Coolify (direct provider).
- Supabase access token `sbp_130fb…` is VALID — do NOT revoke.
<!-- END:session-handoff -->

