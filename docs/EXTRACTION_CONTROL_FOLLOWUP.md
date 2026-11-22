# Extraction control follow-up

Based on main e526b49f682f98fc61b85cad81d9e6c469735f6e. Local implementation only, not deployed.

## Behavior

- Structured extraction resolves the source phone using the original broker ID and/or instance in existing raw-message metadata. The database query is tenant-scoped. Exactly one matching active connection with explicit running status is required. Another running phone cannot grant access.
- Missing, conflicting or ambiguous source identity and failed control lookups deny structured extraction. These rows remain unprocessed, subject to the existing retry window. No alias rerouting is introduced.
- Incoming webhook, internal immediate trigger, explicit external extraction and admin retry use source-specific checks. The worker checks before beginning a durable attempt. The common extraction pipeline checks again at entry.
- Each controlled provider dispatch checks current source consent after cooldown and request preparation. This covers initial, fallback, truncation retry, repair and segmentation calls. SDK automatic retries are disabled only for controlled structured calls so they cannot bypass the check.
- Context is isolated between parallel worker tasks and restored on exit. Control denial is not converted into provider fallback. Existing shared/baseline claims are released on a late denial where available.
- Existing direct business intake is preserved separately. Registered-sender WABA CONFIRM and secret-authenticated business-agent listing/confirmed-requirement handlers call a narrow in-process wrapper. Authorization is bound to the exact storage object, tenant and context for that synchronous call and reset on every exit. An instance name, raw payload, database label, scheduler job or asynchronous retry cannot grant it. This preserves the existing business authorization gates without making unknown WhatsApp sources eligible.
- Scheduler SourceRecord processing uses its existing tenant and instance for the same source control. The only registered implementation is WhatsApp, whose historical fetch currently returns no records. Both paused and running scheduler records are tested; no other source exemption was invented.
- Raw capture, query-time raw-message interpretation, source/group policy, publication, automatic-versus-request-only mode and schemas are unchanged. Personal-DM policy remains a separate held item.

## Honest concurrency limits

Pause/Stop prevents dispatch when the final source-control read observes non-running state. It does not cancel a request already dispatched, undo a result, or create an atomic transaction across the database and provider. A change immediately after the final read can race dispatch. No cross-process atomic cancellation is claimed.

The worker checks before its durable claim, but a pause arriving after that claim can leave one already-started attempt counted. Existing database semantics increment the counter at claim time. This change does not reset counters or add schema/RPC changes. Existing 24-hour expiry also remains in force.

## Verification

62 focused tests passed: source controls, original extraction controls, worker lanes, protocol filtering, extraction scope and shared deduplication. Tests exercise actual storage method, incoming webhook, internal trigger, external extraction route, admin retry, worker pre-attempt rejection, pipeline entry, fake provider dispatch, resume/second-dispatch denial and parallel context isolation. Business tests cover actual WABA direct publishing and authenticated agent listing/requirement handlers, including bad-secret and unconfirmed-requirement denial, authorization reset and scheduler source semantics. All integrations and model calls were replaced with nonproduction fakes.

Expanded selected regression run had six failures in provider order, normalization and price semantics. The exact same six failures reproduced on a pristine export of the unchanged main baseline. The full application pipeline and app-level webhook helper suites could not collect in the available test environment because pandas is missing. These are not claimed passing.

Syntax compilation and git diff whitespace checks passed. Remote main was rechecked and remained e526b49f during implementation. No production records, jobs, credentials, session restarts, pushes, deployments or paid provider calls were made.

## Release boundary

Review the local main commit against the unchanged upstream before applying. Publishing this change and deploying both API and extraction-worker require approval. Do not restart the ingestor or alter capture/session settings for this patch. Authenticated production smoke and race observation remain separate from these local tests.
