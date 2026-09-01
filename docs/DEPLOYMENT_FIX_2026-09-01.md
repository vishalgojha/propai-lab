# Deployment build fix — 2026-09-01

## Scope

Resolved the failed fresh Coolify build for the `api` application. This was a
Docker image build change only; no application layout, runtime business logic,
database schema, or Supabase data was changed.

## Evidence

The failed deployment was Coolify deployment `psrizza3m5jpd2mu0zvrvp86` for
commit `63dc29a6a8854a36562e1bc3a6090598b5ce0bdc`. The build stopped in Docker
step 7 while installing Debian's Chromium dependency set, at `Regenerating
fonts cache...`. It did not reach Python dependency installation or the API
smoke tests. The preceding successful deployment reused an existing image and
skipped the build, so it did not validate a fresh image build.

## Changes made

- Pinned `Dockerfile.api` from floating `python:3.11-slim` to
  `python:3.11-slim-bookworm`, keeping the service on the known-good Debian 12
  image line instead of inheriting a future base-image migration.
- Replaced the external NodeSource setup and second apt repository update with
  Debian's packaged `nodejs` dependency. `agent-browser` is still installed
  globally and Chromium remains available at `/usr/bin/chromium`.
- Kept the existing Playwright/Crawl4AI installation and API compile/import
  smoke tests unchanged.

## Deployment impact

Coolify service requiring redeployment after this commit: `api`
(`api.propai.live`). No Supabase migration is required for this change.

The deployment itself was not triggered by this change. A fresh Coolify build
should be run and its build log checked past the OS-dependency step before
considering the incident closed.

## Verification

The local environment cannot access `/var/run/docker.sock`, so a local Docker
image build could not be run. Dockerfile inspection and repository-level checks
are required before deployment; Coolify remains the authoritative fresh-image
build check.
