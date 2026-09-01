# PropAI Deployment Handoff

This repository contains the PropAI frontend under `frontend/` and a separate Python/API and worker system at the repository root. The redesigned public homepage is implemented in `frontend/src/app/page.tsx` and its scoped visual system is appended to `frontend/src/app/globals.css`.

## Recommended production topology

Deploy the Next.js frontend as its own web service and keep the API, workers, database, WhatsApp connection, and background processing on the existing backend infrastructure. The frontend should not expose service-role credentials or worker secrets.

| Setting | Value |
| --- | --- |
| Frontend root directory | `frontend` |
| Framework | Next.js 16 with App Router |
| Install command | `npm ci` |
| Build command | `npm run build` |
| Start command | `npm run start` |
| Node version | `22` (see `frontend/.nvmrc` / root `.nvmrc` if present) |
| Output | Next.js server output; do not use static export |

The repository also includes `frontend/Dockerfile` for a container-based deployment. Use that path when deploying through Coolify or another Docker-compatible platform.

## Required frontend variables

Set these as production environment variables in the hosting provider. Values must come from the production Supabase project; never commit them to Git.

| Variable | Purpose | Public in browser? |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase project URL used by the browser client | Yes |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anonymous browser key | Yes, but scope it with Supabase policies |
| `LAB_API_BASE_URL` | Base URL for the PropAI API and server-side proxy calls | No; keep server-side where possible |
| `SUPABASE_URL` | Server-side Supabase URL for API integrations | No |
| `SUPABASE_SERVICE_KEY` | Server-side privileged Supabase access | No; secret |
| `DOUBLEWORD_API_URL` | Optional model provider URL used by configured chat flows | No |
| `DOUBLEWORD_API_KEY` | Optional model provider credential | No; secret |
| `DOUBLEWORD_MODEL` | Optional configured model name | No |

For a frontend-only homepage preview, the first two variables are enough to compile. A fully functional authenticated workspace also requires a reachable API and the server-side variables expected by the repository's existing deployment configuration.

## Vercel setup

Create a new Vercel project from this repository and set **Root Directory** to `frontend`. Keep the default Next.js framework preset. Use `npm ci` for installation and `npm run build` for the production build. Add the required environment variables for the Production environment, then redeploy after saving them.

Because this is a server-rendered Next.js app with authenticated routes and API handlers, do not configure it as a static export. The production domain can be assigned from the Vercel project settings, and a custom domain can be added there after DNS verification.

## Docker / Coolify setup

Use the repository's `frontend/Dockerfile` as the build definition. The Dockerfile expects the frontend build context to be the repository root because it copies `frontend/package.json`, `frontend/package-lock.json`, and then `frontend/` into the image. Supply the public Supabase variables as build arguments or environment variables according to the hosting provider's build configuration. Supply `LAB_API_BASE_URL` and server-side credentials at runtime.

The container listens on port `3000` and starts with `npm run start`. Keep the API and worker services on their existing private network and point `LAB_API_BASE_URL` at the internal or public API URL appropriate to the deployment topology.

## Pre-deployment checklist

1. Confirm that the production Supabase URL and anonymous key are configured.
2. Confirm that the API URL resolves from the deployed frontend environment.
3. Run `cd frontend && npm ci && npm run lint && npm run build`.
4. Confirm that `/`, `/auth/login`, `/dashboard`, and `/inbox` load without a server error.
5. Confirm that Supabase redirect URLs include the final production domain.
6. Confirm that no service-role key, WhatsApp credential, or provider secret is exposed in client-side code.
7. Add the final domain to the Supabase authentication URL allowlist and any API CORS allowlist.
8. Verify the public homepage on desktop and mobile widths after the first production deploy.

## Current redesign scope

The new agent-native visual system currently covers the public landing page: the hero, live agent orchestration console, signal strip, system overview, capability cards, evidence trail, call to action, footer, responsive layout, and reduced-motion behavior. The authenticated workspace still contains the prior product UI and can be migrated in a subsequent design pass.
