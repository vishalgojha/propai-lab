"""Standalone extraction worker — polls for unprocessed raw messages.

Usage:
    python3 extraction_worker.py [--poll N]

Alternate to the per-webhook background thread; useful for production
deployments where the API server is scaled horizontally and a single
dedicated worker should own all extraction.
"""

import argparse
import json
import os
import sys
import time
import traceback
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from threading import Lock

from extraction import get_storage, process_raw_message
from message_identity import is_protocol_event

POLL_INTERVAL = int(os.getenv("EXTRACTION_WORKER_POLL_SECONDS", "5"))
# Queue reads carry large raw_payload values and compete with extraction
# writes for the same database I/O budget. Bound deployment overrides too.
_configured_batch_size = int(os.getenv("EXTRACTION_WORKER_BATCH_SIZE", "50"))
BATCH_SIZE = max(1, min(100, _configured_batch_size))
MAX_RETRIES = int(os.getenv("EXTRACTION_WORKER_MAX_RETRIES", "5"))
EXTRACTION_WORKER_BUILD = "typed-persistence-v4"

# Provider-side concurrency ceiling. Keep a hard upper bound, but honor an
# explicit deployment setting below it. The previous 24-slot clamp silently
# ignored Coolify values such as concurrency=50, making the runtime config
# misleading. Provider 429/cooldown handling remains the operational guard.
_configured_concurrency = int(os.getenv("EXTRACTION_WORKER_CONCURRENCY", "24"))
CONCURRENCY = max(1, min(100, _configured_concurrency))

# Keep fresh WhatsApp messages moving while the historical queue drains. The
# total remains CONCURRENCY; these knobs only divide the existing pool.
RECENT_WINDOW_HOURS = float(os.getenv("EXTRACTION_WORKER_RECENT_WINDOW_HOURS", "24"))
LIVE_ONLY = os.getenv("EXTRACTION_WORKER_LIVE_ONLY", "false").strip().lower() in {
    "1", "true", "yes", "on"
}
# Reply context is carried on each raw row, so extraction calls do not depend
# on shared mutable state from earlier rows in the same group. Keep an opt-in
# serial mode for incident debugging, but do not let one busy group collapse
# the whole provider pool by default.
SERIALIZE_GROUPS = os.getenv("EXTRACTION_WORKER_SERIALIZE_GROUPS", "false").strip().lower() in {
    "1", "true", "yes", "on"
}
# Exact-repost reconciliation is maintenance work, not part of the hot
# extraction loop. Keep it opt-in because the historical query can become
# expensive on a large raw_messages table and must never delay fresh posts.
RECONCILE_PENDING_ON_CYCLE = os.getenv(
    "EXTRACTION_WORKER_RECONCILE_PENDING_ON_CYCLE", "false"
).strip().lower() in {"1", "true", "yes", "on"}


def _configured_live_cutoff() -> datetime | None:
    """Parse an optional fixed live-only cutover timestamp once at startup."""
    value = os.getenv("EXTRACTION_WORKER_LIVE_CUTOFF_AT", "").strip()
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError as exc:
        raise ValueError(
            "EXTRACTION_WORKER_LIVE_CUTOFF_AT must be an ISO-8601 timestamp"
        ) from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


LIVE_CUTOFF_AT = _configured_live_cutoff()
DRAIN_SUPPRESSED = os.getenv("EXTRACTION_WORKER_DRAIN_SUPPRESSED", "false").strip().lower() in {
    "1", "true", "yes", "on"
}
DRAIN_TENANT_ID = os.getenv("EXTRACTION_WORKER_DRAIN_TENANT_ID", "").strip() or None
# Split capacity evenly by default so a high-concurrency deployment cannot
# accidentally starve the historical backlog. Operators may still override
# both lane values explicitly for a deliberate freshness priority.
_default_fast_slots = max(1, CONCURRENCY // 2) if CONCURRENCY > 1 else 1
_requested_fast_slots = int(os.getenv("EXTRACTION_WORKER_FAST_LANE_SLOTS", str(_default_fast_slots)))
_requested_backlog_raw = os.getenv("EXTRACTION_WORKER_BACKLOG_LANE_SLOTS", "").strip()
if _requested_backlog_raw:
    # If both lane knobs are supplied, keep their sum within the existing
    # provider ceiling; explicit lane settings also raise the effective pool
    # when needed, so Coolify values are not silently ignored.
    _requested_backlog_slots = max(0, int(_requested_backlog_raw))
    CONCURRENCY = max(
        CONCURRENCY,
        min(100, _requested_fast_slots + _requested_backlog_slots),
    )
    BACKLOG_LANE_SLOTS = max(0, min(CONCURRENCY, _requested_backlog_slots))
    FAST_LANE_SLOTS = max(0, min(CONCURRENCY - BACKLOG_LANE_SLOTS, _requested_fast_slots))
else:
    if CONCURRENCY > 1:
        # Keep at least one slot available for backlog unless the deployment
        # has only one total provider slot, where a split is impossible.
        FAST_LANE_SLOTS = max(0, min(CONCURRENCY - 1, _requested_fast_slots))
    else:
        FAST_LANE_SLOTS = max(0, min(CONCURRENCY, _requested_fast_slots))
    BACKLOG_LANE_SLOTS = max(0, CONCURRENCY - FAST_LANE_SLOTS)

# Optional hard ceiling on cumulative extraction spend (USD), read from
# ai_usage_log.agent = 'extraction'.  When the budget is exhausted the
# worker stops pulling from the queue, so a one-time campaign (or a
# misbehaving provider) can never silently bill past a fixed amount.
# Unset/empty = unlimited.
_budget_raw = os.getenv("EXTRACTION_BUDGET_USD", "").strip()
EXTRACTION_BUDGET_USD = float(_budget_raw) if _budget_raw else None

WORKER_NAME = "extraction-worker"


def _is_stale_extraction_claim(exc: Exception) -> bool:
    """Return whether a fetched row lost eligibility before its atomic claim."""
    return "not available for extraction" in str(exc).lower()


def _heartbeat_payload(*, status: str, last_error: str | None = None) -> dict:
    return {
        "worker_name": WORKER_NAME,
        "service_name": os.getenv("COOLIFY_RESOURCE_NAME", WORKER_NAME),
        "status": status,
        "heartbeat_at": datetime.now(timezone.utc).isoformat(),
        "runtime_version": (
            os.getenv("COOLIFY_COMMIT_SHA")
            or os.getenv("GIT_COMMIT_SHA")
            or os.getenv("COOLIFY_BRANCH")
            or EXTRACTION_WORKER_BUILD
        ),
        "last_error": last_error,
        "config": {
            "batch_size": BATCH_SIZE,
            "concurrency": CONCURRENCY,
            "poll_interval": POLL_INTERVAL,
            "max_retries": MAX_RETRIES,
            "recent_window_hours": RECENT_WINDOW_HOURS,
            "live_only": LIVE_ONLY,
            "live_cutoff_at": LIVE_CUTOFF_AT.isoformat() if LIVE_CUTOFF_AT else None,
            "fast_lane_slots": FAST_LANE_SLOTS,
            "backlog_lane_slots": BACKLOG_LANE_SLOTS,
            "serialize_groups": SERIALIZE_GROUPS,
        },
    }


def _write_heartbeat(storage, *, status: str = "running", last_error: str | None = None) -> None:
    storage.client.table("worker_heartbeats").upsert(
        _heartbeat_payload(status=status, last_error=last_error),
        on_conflict="worker_name",
    ).execute()


def _cumulative_extraction_spend(storage) -> float:
    """Sum of logged extraction cost from ai_usage_log (never raises)."""
    try:
        resp = storage.client.table("ai_usage_log").select("cost_usd").eq("agent", "extraction").execute()
        total = 0.0
        for row in (resp.data or []):
            try:
                total += float(row.get("cost_usd") or 0)
            except (TypeError, ValueError):
                continue
        return round(total, 6)
    except Exception:
        return 0.0


def remaining_budget(storage, budget: float | None) -> float | None:
    """None when unlimited, else budget minus cumulative spend (floor 0)."""
    if budget is None:
        return None
    return max(0.0, budget - _cumulative_extraction_spend(storage))


def row_value(row, key: str, default=None):
    if isinstance(row, dict):
        return row.get(key, default)
    return getattr(row, key, default)


def parse_json(value, default):
    if isinstance(value, (dict, list)):
        return value
    if isinstance(value, str) and value.strip():
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return default
    return default


def context_from_raw(row) -> dict:
    raw_payload = parse_json(row_value(row, "raw_payload"), {})
    data = raw_payload.get("data", raw_payload) if isinstance(raw_payload, dict) else {}
    key = data.get("key", {}) if isinstance(data, dict) else {}
    sender_data = data.get("sender", {}) if isinstance(data, dict) else {}
    msg = data.get("message", {}) if isinstance(data, dict) else {}

    group = (
        key.get("remoteJid")
        or data.get("from")
        or row_value(row, "group_name")
        or ""
    )
    sender_jid = key.get("participant") or sender_data.get("id") or row_value(row, "sender_jid") or ""
    sender_name = sender_data.get("name") or data.get("pushName") or row_value(row, "sender") or ""
    sender_phone = row_value(row, "sender_phone") or ""
    message_uid = row_value(row, "message_uid") or f"{group}:{key.get('id') or row_value(row, 'id')}"

    return {
        "raw_id": int(row_value(row, "id") or 0),
        "sender_name": sender_name,
        "push_name": data.get("pushName") or sender_name,
        "sender_jid": sender_jid,
        "sender_phone": sender_phone,
        "message_hash": row_value(row, "message_hash") or "",
        "group": group,
        "group_name": row_value(row, "group_name") or "",
        "instance": data.get("instance") or raw_payload.get("instance") or "",
        "is_dm": str(group).endswith("@s.whatsapp.net") or str(group).endswith("@lid"),
        "message_uid": message_uid,
        "message_id": key.get("id") or "",
        "msg_text": row_value(row, "message") or "",
        "msg": msg,
        "attachments": parse_json(row_value(row, "attachments"), []),
        "reply_context": parse_json(row_value(row, "reply_context"), {}),
        "tenant_id": row_value(row, "tenant_id") or "",
        "parent_message_id": row_value(row, "parent_message_id"),
        "split_index": row_value(row, "split_index"),
        "raw_payload": raw_payload,
        "timestamp": row_value(row, "timestamp") or "",
        "synced_at": row_value(row, "synced_at") or "",
        "event_id": row_value(row, "event_id") or "",
        "source": row_value(row, "source") or "WHATSAPP",
        "is_group": bool(row_value(row, "is_group", False)),
        "pipeline_version": row_value(row, "pipeline_version") or "",
    }


def recent_cutoff(now=None) -> str:
    """Return the UTC cutoff shared by both mutually-exclusive lane queries."""
    current = now or datetime.now(timezone.utc)
    if LIVE_ONLY and LIVE_CUTOFF_AT:
        return LIVE_CUTOFF_AT.isoformat()
    return (current - timedelta(hours=RECENT_WINDOW_HOURS)).isoformat()


def next_fast_batch(storage, cutoff: str, limit: int = BATCH_SIZE, tenant_ids=None):
    """Fetch one FIFO batch from the recent lane."""
    try:
        return storage.get_unprocessed_raw_messages_since(
            cutoff, limit=limit, tenant_ids=tenant_ids, include_suppressed=DRAIN_SUPPRESSED
        )
    except TypeError:
        return storage.get_unprocessed_raw_messages_since(cutoff, limit=limit)


def next_backlog_batch(storage, cutoff: str, limit: int = BATCH_SIZE, tenant_ids=None):
    """Fetch one FIFO batch from the historical lane."""
    try:
        return storage.get_unprocessed_raw_messages_before(
            cutoff, limit=limit, tenant_ids=tenant_ids, include_suppressed=DRAIN_SUPPRESSED
        )
    except TypeError:
        return storage.get_unprocessed_raw_messages_before(cutoff, limit=limit)


def _legacy_lane_batch(storage, cutoff: str, lane: str, limit: int):
    """Compatibility fallback for older test/dry-run storage doubles.

    Production SupabaseStorage implements the two indexed queries above. This
    fallback keeps local tooling that only implements the original storage
    method usable while filtering conservatively in memory.
    """
    rows = storage.get_unprocessed_raw_messages(limit=limit)
    cutoff_dt = datetime.fromisoformat(cutoff)
    selected = []
    for row in rows:
        # The background market extractor only consumes WhatsApp group posts.
        # Direct/self-chat messages are handled by their explicit intake path;
        # allowing them here causes the agent's conversational replies to be
        # reinterpreted as property requirements.
        if row_value(row, "is_group", False) is not True:
            continue
        value = row_value(row, "timestamp", "")
        if not value:
            is_recent = False
        else:
            try:
                is_recent = datetime.fromisoformat(str(value).replace("Z", "+00:00")) >= cutoff_dt
            except ValueError:
                is_recent = False
        if is_recent == (lane == "fast"):
            selected.append(row)
    return selected


def _fetch_lane(storage, lane: str, cutoff: str, limit: int, tenant_ids=None):
    if lane == "fast" and hasattr(storage, "get_unprocessed_raw_messages_since"):
        return next_fast_batch(storage, cutoff, limit, tenant_ids)
    if lane == "backlog" and hasattr(storage, "get_unprocessed_raw_messages_before"):
        return next_backlog_batch(storage, cutoff, limit, tenant_ids)
    return _legacy_lane_batch(storage, cutoff, lane, limit)


def _raw_broker_id(row) -> str:
    payload = parse_json(row_value(row, "raw_payload"), {})
    data = payload.get("data", payload) if isinstance(payload, dict) else {}
    return str(data.get("broker_id") or payload.get("broker_id") or "").strip()


def _raw_message_from_me(row) -> bool:
    payload = parse_json(row_value(row, "raw_payload"), {})
    data = payload.get("data", payload) if isinstance(payload, dict) else {}
    key = data.get("key", {}) if isinstance(data, dict) else {}
    value = key.get("fromMe", key.get("from_me", False))
    return value is True or str(value).strip().lower() in {"1", "true", "yes"}


def _remove_system_blocked_rows(storage, lane_rows):
    """Apply global source blocks before reserving extraction attempts."""
    loader = getattr(storage, "get_system_extraction_source_blocks", None)
    suppress = getattr(storage, "suppress_raw_message_for_system_block", None)
    fold = getattr(storage, "_source_block_key", None)
    if not loader or not suppress or not fold:
        return lane_rows, 0
    try:
        rules = loader()
    except Exception:
        print("[worker] system source block lookup failed; leaving rows queued", flush=True)
        traceback.print_exc()
        return lane_rows, 0
    if not rules:
        return lane_rows, 0
    blocked = 0
    filtered = []
    for lane, slots, rows in lane_rows:
        eligible = []
        for row in rows:
            text = " ".join(str(row_value(row, key) or "") for key in (
                "message", "sender", "push_name", "group_name"
            ))
            folded = fold(text)
            rule_match = None
            for rule in rules:
                candidates = [rule.get("source_key"), rule.get("display_name")]
                aliases = rule.get("aliases")
                if isinstance(aliases, list):
                    candidates.extend(aliases)
                if any((key := fold(candidate)) and key in folded for candidate in candidates):
                    rule_match = rule
                    break
            if rule_match:
                suppress(int(row_value(row, "id") or 0), rule_match)
                blocked += 1
            else:
                eligible.append(row)
        filtered.append((lane, slots, eligible))
    return filtered, blocked


def _group_policy_snapshot(storage, lane_rows):
    """Load positive group consent for this batch.

    Super Admin status removes selection-count limits, but it does not mean
    every WhatsApp group is automatically eligible for extraction.
    """
    client = getattr(storage, "client", None)
    if client is None:
        # Lightweight test/dry-run storage doubles have no control plane.
        return None
    org_ids = {
        str(row_value(row, "tenant_id") or "")
        for _lane, _slots, rows in lane_rows
        for row in rows
        if row_value(row, "tenant_id")
    }
    try:
        connections = client.table("org_whatsapp_connections").select(
            "id,organization_id,broker_id,is_active"
        ).execute().data or []
        groups = client.table("organization_group_connections").select(
            "organization_id,whatsapp_connection_id,group_jid,is_active,opted_out"
        ).execute().data or []
        return {
            "unlimited_orgs": set(),
            "connections": {
                (str(row.get("organization_id") or ""), str(row.get("broker_id") or "")): row.get("id")
                for row in connections
                if row.get("is_active", True) and row.get("organization_id") and row.get("broker_id")
            },
            "selected": {
                (str(row.get("organization_id") or ""), row.get("whatsapp_connection_id"), str(row.get("group_jid") or ""))
                for row in groups
                if row.get("is_active") and not row.get("opted_out")
            },
        }
    except Exception:
        # A consent lookup failure must fail closed for real workers.
        print("[worker] group consent lookup failed; suppressing this batch", flush=True)
        traceback.print_exc()
        return {"unavailable": True}


def _row_has_group_consent(row, policy) -> bool:
    if policy is None:
        return True
    if policy.get("unavailable"):
        return False
    tenant_id = str(row_value(row, "tenant_id") or "")
    if _raw_message_from_me(row):
        # The connected broker's own posts are eligible from every group they
        # participate in. Group consent still controls messages from others.
        return True
    group_jid = str(row_value(row, "group_name") or "")
    connection_id = policy["connections"].get((tenant_id, _raw_broker_id(row)))
    return bool(connection_id and (tenant_id, connection_id, group_jid) in policy["selected"])


def _row_is_protocol_event(row) -> bool:
    """Check the raw projection before creating an extraction attempt."""
    raw_payload = row_value(row, "raw_payload", {})
    if isinstance(raw_payload, str):
        raw_payload = parse_json(raw_payload, {})
    return is_protocol_event(
        message=str(row_value(row, "message") or ""),
        message_type=str(row_value(row, "message_type") or ""),
        raw_payload=raw_payload,
    )


def _quarantine_protocol_event(storage, raw_id: int) -> None:
    """Retain a transport event while making it ineligible for extraction."""
    marker = getattr(storage, "mark_raw_protocol_event", None)
    if callable(marker):
        marker(raw_id)
    else:
        # Lightweight test/plugin storage may expose only the original marker.
        storage.mark_raw_processed(raw_id)


def _remove_unselected_rows(storage, lane_rows):
    """Keep every non-consented group queued for an explicit later selection."""
    setter = getattr(storage, "set_raw_message_extraction_suppressed", None)
    if not setter:
        return lane_rows, 0
    policy = _group_policy_snapshot(storage, lane_rows)
    filtered = []
    suppressed = 0
    for lane, slots, rows in lane_rows:
        eligible = []
        for row in rows:
            if not _row_has_group_consent(row, policy):
                try:
                    setter(int(row_value(row, "id") or 0), True)
                except Exception:
                    print(f"[worker] could not suppress unselected raw row id={row_value(row, 'id')}", flush=True)
                    traceback.print_exc()
                suppressed += 1
            else:
                eligible.append(row)
        filtered.append((lane, slots, eligible))
    return filtered, suppressed


def _process_lane(storage, rows, lane: str, slots: int, retry_counts: dict):
    """Run the existing per-message pipeline for one reserved lane."""
    stats = {
        "lane": lane,
        "fetched": len(rows),
        "attempted": 0,
        "processed": 0,
        "failed": 0,
        "dead_lettered": 0,
        "skipped": 0,
        "skip_reasons": {},
        "latency_seconds": 0.0,
        "max_latency_seconds": 0.0,
    }
    extractable = []

    for row in rows:
        raw_id = row_value(row, "id")
        if _row_is_protocol_event(row):
            try:
                _quarantine_protocol_event(storage, int(raw_id))
                stats["skipped"] += 1
                stats["skip_reasons"]["protocol_event"] = (
                    stats["skip_reasons"].get("protocol_event", 0) + 1
                )
            except Exception:
                print(f"[worker] could not quarantine protocol raw row id={raw_id}", flush=True)
                traceback.print_exc()
                stats["failed"] += 1
            continue
        attempts = int(row_value(row, "extraction_attempts", retry_counts.get(raw_id, 0)) or 0)

        if attempts >= MAX_RETRIES:
            try:
                dead_letter = getattr(storage, "dead_letter_raw_extraction", None)
                if dead_letter:
                    dead_letter(raw_id, f"exceeded {MAX_RETRIES} extraction attempts", lane=lane)
                else:
                    storage.mark_raw_processed(raw_id)
                stats["dead_lettered"] += 1
            except Exception:
                pass
            continue

        extractable.append(row)

    if extractable and slots > 0:
        lock = Lock()

        def _handle(row):
            raw_id = row_value(row, "id")
            attempts = int(row_value(row, "extraction_attempts", retry_counts.get(raw_id, 0)) or 0)
            started = time.perf_counter()
            attempt_id = None
            ctx = {}
            try:
                begin_attempt = getattr(storage, "begin_raw_extraction_attempt", None)
                if begin_attempt:
                    attempt = begin_attempt(raw_id, lane=lane)
                    attempt_id = int((attempt or {}).get("attempt_id") or 0) or None
                with lock:
                    stats["attempted"] += 1
                ctx = context_from_raw(row)
                result = process_raw_message(raw_id, ctx, storage=storage)
                if isinstance(result, dict) and result.get("storage_status") == "failed":
                    raise RuntimeError("extraction completed without a successful parsed-row write")
                finish_attempt = getattr(storage, "finish_raw_extraction_attempt", None)
                if finish_attempt and attempt_id:
                    storage_status = result.get("storage_status") if isinstance(result, dict) else "stored"
                    extraction_source = result.get("extraction_source") if isinstance(result, dict) else "legacy_caller"
                    finish_attempt(
                        attempt_id,
                        "succeeded" if storage_status == "stored" else "skipped",
                        reason=extraction_source or storage_status or "completed",
                    )
                elapsed = time.perf_counter() - started
                with lock:
                    stats["processed"] += 1
                    stats["latency_seconds"] += elapsed
                    stats["max_latency_seconds"] = max(stats["max_latency_seconds"], elapsed)
                    retry_counts.pop(raw_id, None)
            except Exception as exc:
                if _is_stale_extraction_claim(exc):
                    # The lane query and the RPC claim are intentionally
                    # separate bounded operations. A consent change, another
                    # worker, or a concurrent retry can make a fetched row
                    # ineligible between them. This is not an extraction
                    # failure and must not consume a retry.
                    with lock:
                        stats["skipped"] += 1
                        retry_counts.pop(raw_id, None)
                    print(
                        f"[worker] lane={lane} raw_id={raw_id} skipped: "
                        "no longer available for extraction",
                        flush=True,
                    )
                    return
                finish_attempt = getattr(storage, "finish_raw_extraction_attempt", None)
                if finish_attempt and attempt_id:
                    finish_attempt(attempt_id, "failed", reason=str(exc)[:500])
                # A failed baseline must not permanently strand later exact
                # reposts in repeat_pending. The next retry can become the
                # new serialized baseline.
                try:
                    from message_identity import author_content_fingerprint
                    storage.release_author_content_claim(
                        raw_id,
                        author_content_fingerprint(
                            sender_phone=str(ctx.get("sender_phone") or ""),
                            sender_jid=str(ctx.get("sender_jid") or ""),
                            message=str(ctx.get("msg_text") or ""),
                        ),
                        tenant_id=str(ctx.get("tenant_id") or ""),
                    )
                except Exception:
                    pass
                elapsed = time.perf_counter() - started
                with lock:
                    retry_counts[raw_id] = attempts + 1
                    stats["failed"] += 1
                    stats["latency_seconds"] += elapsed
                    stats["max_latency_seconds"] = max(stats["max_latency_seconds"], elapsed)
                print(
                    f"[worker] lane={lane} raw_id={raw_id} failed "
                    f"(attempt {attempts + 1}/{MAX_RETRIES}):",
                    flush=True,
                )
                traceback.print_exc()

        if SERIALIZE_GROUPS:
            # Incident-debugging mode: preserve the older group FIFO behavior.
            grouped: dict[str, list] = {}
            for row in extractable:
                group_key = str(row_value(row, "group_name") or "")
                grouped.setdefault(group_key, []).append(row)
            for group_rows in grouped.values():
                group_rows.sort(key=lambda row: (
                    str(row_value(row, "timestamp") or ""),
                    int(row_value(row, "id") or 0),
                ))
            work_items = grouped.values()
        else:
            # Each row already carries its reply context. Do not serialize a
            # whole group and leave provider slots idle while a single request
            # takes 20–60 seconds.
            work_items = ([row] for row in extractable)

        workers = max(1, min(slots, len(extractable)))
        with ThreadPoolExecutor(max_workers=workers) as pool:
            if SERIALIZE_GROUPS:
                futures = [
                    pool.submit(lambda batch=batch: [_handle(row) for row in batch], batch)
                    for batch in work_items
                ]
            else:
                futures = [pool.submit(_handle, row) for row in extractable]
            for future in as_completed(futures):
                future.result()

    completed = stats["attempted"]
    avg_ms = (stats["latency_seconds"] / completed * 1000) if completed else 0.0
    print(
        f"[worker] lane={lane} fetched={stats['fetched']} "
        f"attempted={stats['attempted']} stored={stats['processed']} failed={stats['failed']} "
        f"skipped={stats['skipped']} dead_lettered={stats['dead_lettered']} "
        f"avg_latency_ms={avg_ms:.1f} max_latency_ms={stats['max_latency_seconds'] * 1000:.1f}",
        flush=True,
    )
    return stats


def run_cycle(storage, retry_counts: dict):
    """Process one batch of unprocessed raw messages.

    ``retry_counts`` is an in-memory dict mapping raw_id → number of
    failed extraction attempts.  It is intentionally *not* persisted;
    on worker restart the counters reset which gives transient failures
    (e.g. a temporarily unavailable LLM) another chance.

    Four stages, cheapest first:

    1. Dead-letter rows that exhausted their retries.
    2. Skip rows that cannot contain a listing (no provider call at all).
    3. Fetch recent and historical rows through separate FIFO lane queries.
    4. Extract each lane across its reserved bounded thread pool; the two
       pools' combined size is the provider's concurrent-request ceiling.
    """
    running_tenant_ids = None
    if hasattr(storage, "get_running_extraction_tenant_ids"):
        running_tenant_ids = storage.get_running_extraction_tenant_ids()
        if running_tenant_ids == []:
            print("[worker] extraction paused/stopped for all active tenants; raw_messages remain queued", flush=True)
            return 0, 0, 0, 0, 0
        if running_tenant_ids is None:
            print("[worker] extraction control lookup unavailable; failing open", flush=True)
    if DRAIN_SUPPRESSED and DRAIN_TENANT_ID:
        running_tenant_ids = [DRAIN_TENANT_ID]

    reconcile_pending = getattr(storage, "reconcile_pending_repeat_observations", None)
    if RECONCILE_PENDING_ON_CYCLE and reconcile_pending:
        try:
            resolved = reconcile_pending(limit=max(25, BATCH_SIZE))
            if resolved:
                print(f"[worker] reconciled {resolved} pending exact reposts", flush=True)
        except Exception:
            print("[worker] pending exact-repost reconciliation failed", flush=True)
            traceback.print_exc()

    reenable = getattr(storage, "reenable_selected_extraction_rows", None)
    if reenable:
        try:
            reenabled = reenable(limit=BATCH_SIZE * 10)
            if reenabled:
                print(
                    f"[worker] re-enabled {reenabled} previously suppressed rows "
                    "from selected groups",
                    flush=True,
                )
        except Exception:
            # Recovery must never stop normal extraction; retry on the next
            # poll if the bounded control-plane read is temporarily unavailable.
            print("[worker] selected-group re-enable failed", flush=True)
            traceback.print_exc()

    cutoff = recent_cutoff()
    lane_specs = (("fast", FAST_LANE_SLOTS),)
    if not LIVE_ONLY:
        lane_specs += (("backlog", BACKLOG_LANE_SLOTS),)
    else:
        print(
            "[worker] live-only mode: historical backlog is intentionally untouched",
            flush=True,
        )
    # Fetch lanes independently.  A Supabase/PostgREST error in one lane must
    # not prevent the other lane from draining; the failed lane is retried on
    # the next polling cycle.  This is especially important during an index
    # rollout or a transient API failure because the backlog and fast lane use
    # different query plans.
    lane_rows = []
    for lane, slots in lane_specs:
        if slots <= 0:
            continue
        try:
            rows = _fetch_lane(storage, lane, cutoff, BATCH_SIZE, running_tenant_ids)
        except Exception:
            print(f"[worker] {lane} lane fetch failed", flush=True)
            traceback.print_exc()
            continue
        lane_rows.append((lane, slots, rows))
    lane_rows, source_blocked = _remove_system_blocked_rows(storage, lane_rows)
    if source_blocked:
        print(f"[worker] suppressed {source_blocked} globally blocked source rows before extraction", flush=True)
    suppressed = 0
    if DRAIN_SUPPRESSED:
        print(
            f"[worker] one-time suppressed backlog drain enabled"
            f"{f' for tenant {DRAIN_TENANT_ID}' if DRAIN_TENANT_ID else ''}",
            flush=True,
        )
    else:
        lane_rows, suppressed = _remove_unselected_rows(storage, lane_rows)
    if suppressed:
        print(f"[worker] suppressed {suppressed} unselected group rows; raw messages remain queued", flush=True)
    # The lane executors reserve disjoint slot pools, so both lanes can make
    # progress at once while their combined extraction calls remain bounded
    # by CONCURRENCY.
    with ThreadPoolExecutor(max_workers=2) as lane_pool:
        futures = [
            lane_pool.submit(_process_lane, storage, rows, lane, slots, retry_counts)
            for lane, slots, rows in lane_rows
            if slots > 0
        ]
        lane_stats = [future.result() for future in futures]

    attempted = sum(item["attempted"] for item in lane_stats)
    processed = sum(item["processed"] for item in lane_stats)
    failed = sum(item["failed"] for item in lane_stats)
    dead_lettered = sum(item["dead_lettered"] for item in lane_stats)
    skipped = sum(item["skipped"] for item in lane_stats)
    skip_reasons: dict[str, int] = {}
    for item in lane_stats:
        for reason, count in item["skip_reasons"].items():
            skip_reasons[reason] = skip_reasons.get(reason, 0) + count

    if dead_lettered:
        print(
            f"[worker] dead-lettered {dead_lettered} messages "
            f"(exceeded {MAX_RETRIES} retries)",
            flush=True,
        )
    if skipped:
        detail = " ".join(f"{k}={v}" for k, v in sorted(skip_reasons.items()))
        print(f"[worker] skipped {skipped} non-listing messages ({detail})", flush=True)
    return attempted, processed, failed, dead_lettered, skipped


def main():
    parser = argparse.ArgumentParser(description="Extraction worker")
    parser.add_argument("--poll", type=int, default=POLL_INTERVAL, help="Poll interval in seconds")
    args = parser.parse_args()

    storage = get_storage()
    retry_counts: dict[int, int] = {}
    try:
        _write_heartbeat(storage)
    except Exception:
        print("[worker] unable to write initial extraction heartbeat", flush=True)
        traceback.print_exc()
    print(
        f"[worker] Extraction worker started — build={EXTRACTION_WORKER_BUILD} "
        f"polling every {args.poll}s "
        f"(batch={BATCH_SIZE} concurrency={CONCURRENCY} max_retries={MAX_RETRIES} "
        f"recent_window_hours={RECENT_WINDOW_HOURS:g} "
        f"live_only={LIVE_ONLY} "
        f"live_cutoff_at={LIVE_CUTOFF_AT.isoformat() if LIVE_CUTOFF_AT else 'rolling-window'} "
        f"lane_slots=fast:{FAST_LANE_SLOTS}/backlog:{BACKLOG_LANE_SLOTS} "
        f"reconcile_pending_on_cycle={RECONCILE_PENDING_ON_CYCLE} "
        f"budget={'$' + format(EXTRACTION_BUDGET_USD, '.2f') if EXTRACTION_BUDGET_USD is not None else 'unlimited'})",
        flush=True,
    )

    last_heartbeat = 0.0
    last_error = None
    while True:
        try:
            now = time.monotonic()
            if now - last_heartbeat >= 30:
                try:
                    _write_heartbeat(storage, last_error=last_error)
                    last_heartbeat = now
                    last_error = None
                except Exception:
                    print("[worker] unable to write extraction heartbeat", flush=True)
                    traceback.print_exc()
            if remaining_budget(storage, EXTRACTION_BUDGET_USD) == 0.0:
                spent = _cumulative_extraction_spend(storage)
                print(
                    f"[worker] EXTRACTION_BUDGET_USD reached (${spent:.2f} spent) — stopping.",
                    flush=True,
                )
                break
            # Do not run a global existence query before the lane fetches.
            # That query is not tenant/lane scoped and can block on the large
            # raw_messages table under Supabase I/O pressure. The fast and
            # backlog fetches are already bounded and indexed; an empty pair
            # of lane results is the queue-empty signal.
            attempted, stored, failed, dead_lettered, skipped = run_cycle(storage, retry_counts)
            if attempted or dead_lettered or skipped:
                cleared = stored + dead_lettered + skipped
                print(
                    f"[worker] cycle done: attempted={attempted} stored={stored} failed={failed} "
                    f"skipped={skipped} dead_lettered={dead_lettered} "
                    f"remaining=not_counted cleared={cleared}",
                    flush=True,
                )
        except Exception as exc:
            last_error = str(exc)[:500]
            print("[worker] Cycle error:", flush=True)
            traceback.print_exc()
        time.sleep(args.poll)


if __name__ == "__main__":
    main()
