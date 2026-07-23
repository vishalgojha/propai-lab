@AGENTS.md

<!-- BEGIN:session-handoff (last updated 2026-07-23) -->
# Session Handoff — PropAI

## Current state (2026-07-23): Provider probe loop needs api redeploy

### Completed this session
- **CountUp fix** (`apps/www/src/components/CountUp.tsx`): Renders real value in SSR HTML (crawlers see actual numbers), animates from 0 on client (users see count-up effect).
- **Capability timestamp fix** (`app.py`): `_capability_type_counts` and `_capability_coverage` now handle JSONB string timestamps (not just datetime objects). Crawlers will see real counts instead of "Idle"/0.
- **Documentation suite** (`docs/`): PRODUCT, DATA_QUALITY, SEO, GLOSSARY, DECISIONS, ARCHITECTURE, UX. AGENTS.md rewritten as index.

### NOT YET COMMITTED (code edits done, mixed with pre-existing dirty changes)
- `app.py` and `storage/supabase.py` have the tenant guards applied but are NOT committed
  because `app.py` was already dirty (pre-existing `generate_summary_title` refactor).
  Stage only specific hunks when committing.

### Key files touched this session
- `apps/www/src/components/CountUp.tsx` — SSR-first counter (crawlers see real values)
- `app.py` lines 4076-4085 — `_capability_type_counts` timestamp fix
- `app.py` lines 4131-4140 — `_capability_coverage` timestamp fix
- `docs/` — 7 new documentation files

### Pending work
1. Redeploy **api** container (Provider Health page shows no data — probe loop not started).
2. Investigate WhatsApp ingestor (most capabilities "Idle", Self-Chat Agent 0 messages).
3. Investigate missing group messages (sync_jobs has groups but raw_messages has 0).
4. Investigate missing provider rows (Groq/Cerebras not in llm_providers).
5. Fix corrupted nvidia model_name in DB.

### DEFAULT TENANT
`00000000-0000-0000-0000-000000000010` = "PropAI Workspace" (legacy backfill target).
`b841327d-081c-4632-932e-8fba73b2061a` = "vishal" (live org; listings already there).

### CRITICAL PATTERNS
- Git author: `vshalgojha <vishal@chaoscraftlabs.com>`
- Remote: `https://github.com/vishalgojha/propai-lab.git`
- Supabase MCP tools: `supabase_execute_sql`, `supabase_apply_migration` (~15s/call)
- `propai_query_sql` RPC returns JSONB — timestamps come back as strings, not datetime objects
- Pre-existing pytest failures NOT from my changes: `test_audit_insights_is_tenant_scoped`, `test_tenant_isolation_tier2`
- Pre-existing TypeScript errors NOT from my changes: `natural-search.test.ts`, `apps/mcp/src/*.ts`
- `apps/www` test runner: `npx tsx test/<name>.test.ts`
<!-- END:session-handoff -->
