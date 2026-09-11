# Legacy and dead-code audit

Audit date: 2026-09-11

Scope: tracked source, deployment manifests, migration history, static call-site
search, and local syntax checks. No production rows were changed.

## Executive summary

The repository contains a live typed Supabase pipeline alongside several older
CSV/SQLite-era surfaces. The strongest cleanup candidates are the orphaned
`inventory.py`, `embedding.py`, and `events.py` modules, the offline `evidence/`
engine, and stale package metadata. Supabase has a second group of likely dead
tables left from the original schema; their live row counts and catalog presence
could not be verified because the available management credential returned
`Unauthorized`.

No table should be dropped from this audit alone. In particular,
`parsed_output_legacy` is explicitly retained as a historical archive and is
still probed by `storage/supabase.py`; it is legacy, but not currently safe to
classify as dead.

## Findings

### High confidence: repository dead/legacy code

1. `inventory.py` has no non-test import or deployment entrypoint. It is a
   standalone normalization/fingerprint helper from the older local inventory
   model. The current extraction path uses `extraction.py`, typed tables, and
   `source_authority.py` instead.
2. `embedding.py` has no non-test import or deployment entrypoint. Its 384-dim
   TF-IDF/FastEmbed abstraction is superseded by `semantic_embeddings.py`, the
   `semantic_embedding_worker` service, and the `semantic_embeddings` table.
3. `events.py` has no non-test import or deployment entrypoint. Its in-process
   event bus is not the current SSE/operational-event path.
4. `evidence/` is an orphaned offline CSV architecture. `evidence/pipeline.py:28-30`
   writes `data/observations.csv` and `data/unresolved_observations.csv`; its
   adapters target Housing, MagicBricks, MahaRERA, IGR, and WhatsApp. No
   production service imports the pipeline or adapters. `routers/infra.py` and
   `routers/common.py` still dynamically import only the old CSV resolver, so
   deletion requires first removing or replacing those resolver lookups.
5. Root `package.json:20-28` advertises missing `schema.sql` and `sync.py`, and
   also packages the obsolete-looking `embedding.py` and `events.py`. This is
   stale package metadata and can mislead local installs.

### Medium confidence: legacy compatibility and stale paths

1. `storage/supabase.py:9201-9218` still queries `parsed_output_legacy` to
   support `resolver_decisions` and `enrichment_jobs`. The migration history
   says the old flat relations were removed from the application, but the
   archive is intentionally retained. Consolidate or retire these consumers
   only after checking historical audit/enrichment requirements.
2. `routers/audit.py:905-906` still counts `observations` and
   `observation_evidence`, while the current typed feed is queried through
   `parsed_output_unified` at `routers/audit.py:1262-1280`. These look like
   stale metrics paths because there are no current application writers found
   for the two old observation tables.
3. `apps/www/src/lib/localities.ts:1465-1467` contains a comment documenting a
   removed per-request `parsed_output` title lookup. The active code is already
   typed-view based; this is harmless documentation drift, not a live bug.

### Likely dead Supabase tables (static evidence only)

These tables are created by the early migrations but have no current
application call-site found outside migrations/tests, and no identified writer:

- `learning_cards`
- `listing_observations`
- `observation_batches`
- `alias_suggestions`
- `broker_aliases_global`
- `combined_locality_rules`
- `companion_config`
- `companion_team_members`
- `companion_audit_log`
- `companion_conversations`
- `companion_messages`
- `conversation_index`

`observations` and `observation_evidence` are also likely legacy tables, but
they remain referenced by the admin audit query and therefore need a route
cleanup before removal. `knowledge_*` and the old `embeddings` table already
have an explicit drop migration in
`supabase/migrations/20260808220000_remove_legacy_knowledge_store.sql:5-11`;
they should not be recreated merely because their original CREATE statements
remain in migration history.

## Explicitly not dead

- The eight typed listing/requirement tables and their unified/public/matching
  views: active extraction, search, public SSR, and matching consumers exist.
- `raw_messages`: source evidence and queue authority.
- `parsed_output_legacy`: historical archive still probed by the storage layer.
- `broker_teams`, `broker_team_members`, and `broker_team_evidence`: current
  broker-team feature and evidence model; low static reference counts are not
  enough to remove them.
- `entity_enrichment_cache`, `crm_inventory_attachments`, semantic evaluation
  tables, lead tables, and social-flow tables: current worker/router consumers
  exist even where use is concentrated in one service.

## Verification and limits

- Static call-site scan covered Python, TypeScript/TSX, JavaScript, Go, YAML,
  and TOML while excluding dependency/build directories.
- Python syntax compilation passed for the repository production modules.
- Supabase catalog/row-activity query was attempted read-only and failed with
  `Unauthorized`; therefore this report does not claim that any candidate is
  empty in production.

## Recommended cleanup order

1. Remove stale package metadata and confirm no external consumer relies on the
   root package.
2. Replace the remaining CSV resolver imports with the canonical registry path,
   then delete the offline `evidence/` engine and its unused adapters.
3. Delete `inventory.py`, `embedding.py`, and `events.py` after one final
   repository-wide import check.
4. Rewrite admin metrics that count `observations`/`observation_evidence` to
   typed projections.
5. With a valid read-only Supabase connection, record each candidate table's
   `relkind`, row count, last analyze/write evidence, foreign-key dependents,
   RLS/grants, and application references. Only then create a reviewed DROP
   migration, preserving an archive/export where required.
