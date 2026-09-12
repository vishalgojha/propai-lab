# Model-first extraction audit — 2026-09-12

## Verdict

**Partial: the local replay/evaluation harness is ready, but a fresh production
before/after measurement is currently blocked by Supabase query timeouts.** No
production rows or queue state were changed during this audit.

## Evidence available

The existing source-grounded corpus audit recorded:

- 831,213 captured `raw_messages`;
- 54,605 typed listing rows;
- 100% typed-row linkage back to raw evidence;
- 1,792 raw messages producing multiple typed rows;
- a bounded 240-case replay manifest and regression harness.

The model-first changes now in `main` are commits `aa0df5bd` (full-document
extraction), `826e7d22` (confidence separation), and `c78bac3e` (title
reconciliation). The correction policy is `06dc36ae`, region configuration is
`29063405`, and Sarvam pricing is `8c837eb2`.

## Fresh production probe

Two read-only Supabase Management API queries were attempted on 2026-09-12:

1. A bounded aggregate over `raw_messages` and the four typed tables timed out
   after approximately 60 seconds.
2. A smaller `now()` plus `count(*)` probe on `raw_messages` timed out after
   approximately 30 seconds with no response.

Because even the small probe did not complete, this audit does not claim fresh
counts, post-deployment model-confidence coverage, or before/after accuracy.
It also does not retry with a larger timeout or mutate indexes/queue state.

## Required next measurement

After Supabase health recovers, run the existing bounded corpus builder and
replay/evaluation flow against a fixed stratified sample. Compare legacy and
model-first outputs on source slices, listing count, building identity, price
period, title consistency, model confidence, and pipeline review flags.
