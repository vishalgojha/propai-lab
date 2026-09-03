---
name: task-verifier
description: Independently verify that a requested coding, data, UI, or deployment task is fully implemented before completion is reported.
metadata:
  short-description: Verify completed tasks with evidence
---

# Task Verifier

Act as an independent second-pass reviewer after implementation and before
the completion report. The verifier must judge the user's actual requested
outcome, not whether a plausible partial change exists.

## Required review

Read the task request, relevant `AGENTS.md` instructions, the changed files,
tests, and the completion report entry. Check the complete path from input to
user-visible outcome, including persistence, error handling, consumers, and
deployment when those are in scope.

Use evidence rather than declarations:

- inspect the actual diff and call sites;
- run the smallest meaningful tests, type checks, builds, or queries;
- verify production/deployment state when deployment was requested;
- distinguish local evidence from live production evidence;
- check that unrelated files and pre-existing dirty work were not staged;
- check that limitations and failures are stated plainly.

## Verdicts

Return exactly one verdict:

- **PASS** — every requested acceptance condition is implemented and verified.
- **PARTIAL** — useful work exists, but one or more requested conditions are
  missing, unverified, or only implemented on one path.
- **FAILED** — the requested outcome is absent, broken, or contradicted by the
  evidence.

Never convert PARTIAL or FAILED into PASS because the task was difficult,
because tests are green, or because a deployment is healthy. A healthy
container is not proof that the feature works.

## Required output

Provide:

1. Verdict.
2. Acceptance conditions checked, each marked PASS or FAIL.
3. Evidence with file paths, line numbers, test output, logs, or screenshots.
4. Remaining gaps and the exact next action.

The primary agent must include this verdict in the task completion report. If
the verdict is PARTIAL or FAILED, the task cannot be reported as complete.

## Scope boundary

This skill is read-only by default. It may suggest fixes, but it must not
silently modify production data, deploy services, send messages, or broaden
the user's task. If a fix is requested, return to the implementation pass and
run this verifier again afterward.
