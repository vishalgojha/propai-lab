# Capacity and query-safety controls

PropAI has separate API, frontend, WhatsApp-ingestor, and extraction-worker
services. The controls below protect each API process and keep extraction
provider concurrency bounded; they are not a substitute for a distributed
quota service when the API is scaled horizontally.

## API query controls

All user-facing raw-message, search, group-directory, and member reads clamp
pagination before querying storage. The default maximum page size is 100 and
the default maximum offset is 10,000. Configure these with:

```text
PROPAI_MAX_PAGE_SIZE=100
PROPAI_MAX_OFFSET=10000
```

The opt-out directory is a deliberate exception: it must expose every group
that a broker can review, so it has its own finite safety ceiling rather than
silently using the normal 100-row page size:

```text
PROPAI_GROUP_DIRECTORY_MAX=1000
```

If a connection can exceed that ceiling, the directory endpoint should be
given cursor pagination before raising this value.

The API also applies dependency-free per-process sliding-window limits. The
default limits are deliberately conservative and can be overridden per API
service:

```text
PROPAI_RATE_LIMIT_PER_MINUTE=240
PROPAI_SEARCH_RATE_LIMIT_PER_MINUTE=60
PROPAI_CHAT_RATE_LIMIT_PER_MINUTE=30
PROPAI_EXPORT_RATE_LIMIT_PER_MINUTE=10
```

These limits use an anonymized auth-token hash (or client IP when unauthenticated)
and return `429` with `Retry-After`. With multiple API replicas, enforce the
same policy at the Coolify ingress/reverse proxy or use a shared Redis-backed
limiter; the in-process limiter intentionally cannot coordinate across replicas.

Repeated query parsing is cached briefly per process. Tune it with:

```text
PROPAI_SEARCH_PARSE_CACHE_ENTRIES=512
PROPAI_SEARCH_PARSE_CACHE_SECONDS=60
```

The raw-search route does not fall back to loading a large raw-message page and
filtering it in Python. If its indexed/database search path is unavailable, it
returns an explicit empty degraded result so a database incident cannot become
an unbounded memory/CPU scan.

## Database connections

Keep API services on the Supabase pooler and use bounded, long-lived clients;
do not create a new database client per request. Add indexes for every column
used by tenant, timestamp, locality, broker, and status filters, and retain
bounded pagination on every list endpoint. Verify query plans with `EXPLAIN`
before adding more replicas: replicas multiply connection and query pressure.

## Extraction

`EXTRACTION_WORKER_CONCURRENCY` remains the single provider concurrency ceiling.
The worker divides that ceiling between fast and backlog lanes using:

```text
EXTRACTION_WORKER_RECENT_WINDOW_HOURS=24
EXTRACTION_WORKER_FAST_LANE_SLOTS=3
EXTRACTION_WORKER_BACKLOG_LANE_SLOTS=2
```

The two lane values must fit within the total concurrency. Monitor the lane
logs and increase only after provider 429s and database latency remain clean;
do not scale worker replicas without coordinating claim/lease behavior.
