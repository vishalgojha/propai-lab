# Gmail → PropAI Market Inbox

The old Activepieces flow is retired. PropAI now uses the small
`gmail-ingestor` service in `services/gmail-ingestor/`; it polls one Gmail
label, forwards new messages to the API, and never modifies Gmail.

## Coolify configuration

Add these runtime variables to the `gmail-ingestor` service:

```text
PROPAI_API_URL=http://api:8000
PROPAI_EMAIL_INGEST_TOKEN=<long random token; same value on api>
PROPAI_EMAIL_INGEST_TENANT_ID=<workspace organization UUID>
GMAIL_USER=your-mailbox@gmail.com
GMAIL_LABEL=PropAI/Incoming
GMAIL_QUERY=label:PropAI/Incoming newer_than:7d
GMAIL_CLIENT_ID=<Google OAuth client ID>
GMAIL_CLIENT_SECRET=<Google OAuth client secret>
GMAIL_REFRESH_TOKEN=<OAuth refresh token>
GMAIL_POLL_SECONDS=60
```

The API service needs `PROPAI_EMAIL_INGEST_TOKEN` and
`PROPAI_EMAIL_INGEST_TENANT_ID` as well. No public port is required for the
poller.

## One-time Google setup

1. In Google Cloud, enable the Gmail API.
2. Create an OAuth client for a **Desktop app**.
3. Authorize the mailbox with the narrow Gmail scope
   `https://www.googleapis.com/auth/gmail.readonly`.
4. Store the resulting refresh token in Coolify as `GMAIL_REFRESH_TOKEN`.
5. Create the Gmail label `PropAI/Incoming` and move or filter property emails
   into it.

The poller reads at most 50 messages per pass and uses the Gmail message ID for
idempotency. The API stores each accepted message as a `GMAIL` raw message with
`processed=false`; the existing extraction worker handles classification and
typed persistence afterward.

The endpoint is `POST /email-ingest` on the API service and accepts a small
provider-neutral JSON envelope. It is bearer-token protected and tenant-scoped.
