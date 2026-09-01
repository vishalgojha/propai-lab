# Phase 7 — Orphaned Reprocessing Queue Jobs

Date: 2026-09-01

## Achieved

Fresh inspection found exactly five jobs still marked `queued` even though
their `residential_sale_listings` source rows no longer existed:

- Job IDs: **19475, 22139, 22224, 22452, 27239**
- Source row IDs: **4049, 814, 4065, 20230, 4050**

The migration marked only those jobs as `no_source`, recorded a deterministic
reason in `last_error` and `result`, and set `completed_at`. No listing or
raw-message rows were modified.

## Production verification

The migration was applied to production. Verification confirmed the five
target jobs are no longer queued and no matching source rows exist.

## Coolify redeployment

No redeploy is required. The queue worker will observe the updated status on
its next query; restart only if operationally required by the deployment
process.
