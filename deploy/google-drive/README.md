# PropAI → Google Drive inventory export

`google-drive-sync` maintains selected, private CRM inventory in a Google Sheet
inside a dedicated folder owned by the broker’s Google account. It is an
outbound export and does not ingest Drive content.

Set these variables on both `api` and `google-drive-sync` in Coolify:

- `GOOGLE_DRIVE_CLIENT_ID`
- `GOOGLE_DRIVE_CLIENT_SECRET`
- `GOOGLE_DRIVE_REDIRECT_URI=https://app.propai.live/api/google-drive/callback`
- `PROPAI_TOKEN_ENCRYPTION_KEY` (a stable Fernet key, preferred)

The Google Cloud OAuth client must allow the callback URI. PropAI requests the
narrow `drive.file` scope plus Sheets access. Each workspace chooses which
private CRM rows to export; changes enqueue a tenant-scoped sync job.
