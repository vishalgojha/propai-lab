# Google Drive inventory integration

Status: foundation implemented and pushed in commit `20e77b84`.

## Purpose

PropAI exports broker-selected private CRM inventory and selected Market Inbox
options to a Google Sheet in the broker's Google Drive. This is an outbound
integration for a downstream AI agent. It does not ingest Google Drive content
and does not publish private CRM rows to the shared PropAI market.

## Implemented

- Google OAuth with PKCE and offline access.
- Encrypted access and refresh token storage.
- Token expiry detection and refresh-token renewal.
- Tenant-scoped Drive connection and export records.
- Dedicated Drive folder and one Sheet per export.
- Snapshot export of selected `crm_inventory` rows or visible Market Inbox listing rows.
- Market exports include structured property fields plus broker name and phone
  so a broker's connected Meta AI can offer alternatives to a lead.
- Automatic sync-job enqueue after CRM create, update, delete, and import.
- Manual export status and sync endpoints.
- Job deduplication so one export does not accumulate duplicate open jobs.
- Checksums, exported row counts, last success, and last error tracking.
- Gmail worker removed from the active compose deployment slot.

## Database

Migration required in production Supabase:

`supabase/migrations/20260903090000_google_drive_inventory_exports.sql`

Tables:

- `google_drive_oauth_states`
- `google_drive_connections`
- `google_drive_exports`
- `google_drive_sync_jobs`

## Deployment handoff

Commit `20e77b84` is pushed to `origin/main`. Redeploy the API and deploy or
create the internal `google-drive-sync` worker from the updated Coolify
configuration.

Required server-side variables on both API and worker:

- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_CLIENT_SECRET`
- `GOOGLE_DRIVE_REDIRECT_URI=https://app.propai.live/api/google-drive/callback`
- `PROPAI_TOKEN_ENCRYPTION_KEY` — stable Fernet key; do not rotate casually
- `SUPABASE_URL`
- `SUPABASE_SERVICE_KEY`

The Google Cloud OAuth client must allow the callback URI exactly. Requested
Google scopes are `drive.file` and Sheets access.

## API surface

- `GET /api/google-drive/connect` — begin OAuth.
- `GET /api/google-drive/callback` — finish OAuth and redirect to CRM.
- `GET /api/google-drive` — connection and export status.
- `POST /api/google-drive/exports` — create/update an export from selected CRM
  IDs or Market Inbox references.
- `POST /api/google-drive/exports/{id}/sync` — queue a manual sync.
- `DELETE /api/google-drive/exports/{id}` — disable an export without deleting the Drive file.

## Important limitations / follow-up

1. Meta AI is outside PropAI's control. Drive indexing, account eligibility,
   region availability, and Meta's refresh behaviour can affect when a change
   becomes usable to the agent.
2. The worker writes a full snapshot for each selected export. This is safer
   and simpler than row-level mutation, but large exports should eventually use
   pagination or a database-side export view.
3. “Immediate” availability inside a downstream Meta agent is not guaranteed;
   Drive indexing and agent refresh behaviour are external to PropAI.
4. Disabling an export intentionally leaves the Google file in place. Add an
   explicit, separately confirmed delete/revoke flow if files must be removed.
5. Failed jobs are marked failed and exposed through export status. A later
   retry/backoff policy and operator UI should be added before relying on this
   for high-volume production exports.
6. The old `/email-ingest` API compatibility route may remain in the backend,
   but Gmail is no longer an active Coolify worker or supported deployment path.

## Broker workflow: Market Inbox to Meta AI on WhatsApp

1. Connect the broker's own Google account from PropAI → Google Drive. PropAI
   creates and maintains a private folder and Sheet in that account.
2. Open Market Inbox, select the advertised property and the additional
   options the broker wants Meta AI to know about, then click **Export to Google
   Drive**.
3. In Meta's WhatsApp AI setup, follow the current instructions at [Meta AI
   for WhatsApp](https://en-gb.facebook.com/business/m/ai/whatsapp). Connect the
   same Google Drive account and choose the PropAI Market Inventory Sheet if
   Meta presents a file-selection step.
4. The Sheet is the broker's current inventory reference. It contains title,
   location, transaction, asset type, layout, area, price, availability,
   description, broker name, and broker phone. The phone is included because
   this is the broker's private Drive file; it is not added to public HTML.
5. When the broker changes the selected options, PropAI queues a new snapshot.
   The Sheet is rewritten as a complete current snapshot: deleted or no-longer-
   visible rows disappear, while rented, sold, or otherwise unavailable rows
   remain with their lifecycle/availability status so Meta AI does not present
   them as currently available.

Meta's exact menus and Drive-reading behaviour are controlled by Meta and may
vary by account, country, product rollout, or verification status. PropAI can
confirm that its own Sheet is synced; it cannot guarantee Meta has re-indexed
the file immediately or that every Meta account can use the Drive connection.

## Verification before calling it live

1. Set the variables above in Coolify.
2. Confirm the Google OAuth redirect URI.
3. Redeploy API and `google-drive-sync`.
4. Connect one test workspace.
5. Select one or two private CRM records and create an export.
6. Confirm the Sheet is inside the dedicated Drive folder. A Market Inbox
   export should contain broker phone numbers because it is private to that
   broker's Drive; a private CRM export does not.
7. Edit one CRM record or change the selected Market Inbox set and confirm a new sync job completes and the Sheet
   changes.
8. Delete or disable the record and confirm the next snapshot removes it from
   the Sheet while the source CRM operation remains tenant-scoped.
