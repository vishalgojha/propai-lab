"""Local Intelligence Lab — Webhook Receiver + Pipeline + Admin API."""
import asyncio
import fcntl
import json
import logging
import os
import sys
import time
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timezone
from pathlib import Path

import httpx
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from routers.common import (
    storage,
    _ingestor_urls,
    _ingestor_auth_headers,
    _broker_live_statuses,
    _merged_ingestor_list,
    _first_ingestor_response,
    _best_ingestor_status_for_broker,
    _ingestor_failure_message,
    _admin_whatsapp_session,
    _summarise_provider,
    _bucket_history,
    _probe_provider,
    _connection_details,
    _market_sync_ready,
    _table_exists,
    _count_table,
    _today_count,
    _business_api_get_config_value,
    _business_api_set_config_value,
    _business_api_member,
    _mobile_digits,
    _is_propai_shared_waba,
    _mask_secret,
    _platform_waba_values,
    _workspace_waba_values,
    _business_api_config_for,
    _waba_session_update,
    _waba_session_status,
    _waba_send_message,
    _waba_callback_url,
    _download_waba_media,
    _resolve_waba_webhook_config,
    _process_business_api_webhook,
    _send_url,
    _notify_broker_of_lead,
    _load_evidence_cache,
    _status_file,
    _cache_connection_snapshot,
    _memory_status,
    _previous_status,
    business_window_status,
    get_scheduler,
    MEDIA_DIR,
    INGESTOR_INTERNAL_URL,
    INGESTOR_PUBLIC_URL,
    COMPANION_ROLES,
    PROPAI_SHARED_WABA_NUMBER,
    _json_list,
    _display_phone_from_whatsapp_id,
    parse_group_name,
    _group_jid_to_name,
    _audit_rows,
    _audit_row_value,
    _audit_scalar,
    _audit_count,
    _audit_timestamp,
    _audit_group_display_name,
    _audit_buildings_for_group,
    _clean_audit_building_name,
    _AUDIT_BUILDING_LABEL_PATTERN,
    _AUDIT_BUILDING_PLACEHOLDERS,
)
from routers.infra import (
    router as infra_router,
    get_embedder,
)
from routers.send import replay_raw_messages as replay_market_inbox
from storage import SupabaseStorage, ProviderOutageEvent
from lab.config import HOST, PORT, SUPABASE_URL, SUPABASE_SERVICE_KEY, FRONTEND_URL
from routers.protection import SlidingWindowLimiter, request_identity

_logger = logging.getLogger(__name__)

PROJECT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(PROJECT_DIR))

PROVIDER_PROBE_INTERVAL_S = 60
HISTORY_BACKFILL_INTERVAL_S = 6 * 3600
# Keep maintenance work from starving authenticated API requests when the
# Supabase project is under load.  It can be increased deliberately once the
# live request path is stable.
ENRICHMENT_POLL_INTERVAL = 60
ENRICHMENT_BATCH_SIZE = 5
STARTUP_REPLAY_LOCK = "/tmp/propai-market-inbox-replay.lock"


@asynccontextmanager
async def lifespan(app: FastAPI):
    global storage
    using_supabase = bool(SUPABASE_URL and SUPABASE_SERVICE_KEY)
    if not using_supabase:
        raise RuntimeError("Supabase is required. Set SUPABASE_URL and SUPABASE_SERVICE_KEY.")
    print(f"  Using Supabase backend: {SUPABASE_URL}")
    storage = SupabaseStorage(SUPABASE_URL, SUPABASE_SERVICE_KEY)
    import routers.common as _common
    _common.storage._real = storage
    key_path = PROJECT_DIR / ".api_key"
    if not key_path.exists():
        new_key = str(uuid.uuid4())
        key_path.write_text(new_key)
        print(f"  Generated API key: {new_key}")
    print(f"  Supabase: {SUPABASE_URL}")
    # Never run maintenance consumers inside the HTTP serving process by
    # default. Uvicorn starts more than one worker, so every process used to
    # run the same enrichment, provider-probe, and history-backfill loops.
    # Those duplicate Supabase queries exhausted the database statement
    # timeout and starved ordinary requests such as /api/profile and WhatsApp
    # pairing. Enrichment has its own worker service; the remaining loops can
    # be enabled only for a deliberately single-process maintenance service.
    background_tasks: list[asyncio.Task] = []
    if os.getenv("PROPAI_RUN_API_MAINTENANCE_LOOPS", "").strip().lower() in {"1", "true", "yes"}:
        background_tasks = [
            asyncio.create_task(_provider_probe_loop()),
            asyncio.create_task(_history_backfill_loop()),
            asyncio.create_task(_enrichment_loop()),
            asyncio.create_task(_startup_replay_once()),
        ]
        print("  Background loops enabled: provider-probe, history-backfill, enrichment")
    else:
        print("  Background loops disabled in API web workers")
    try:
        yield
    finally:
        for task in background_tasks:
            task.cancel()
        if background_tasks:
            await asyncio.gather(*background_tasks, return_exceptions=True)


async def _startup_replay_once() -> None:
    """Replay raw messages into the typed extraction destinations once after startup."""
    lock_fd = None
    try:
        lock_fd = os.open(STARTUP_REPLAY_LOCK, os.O_CREAT | os.O_RDWR, 0o600)
        try:
            fcntl.flock(lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            print("  [startup-replay] another worker already owns the replay lock; skipping", flush=True)
            return

        target_tenant = (os.getenv("PROPAI_REPLAY_TENANT_ID", "") or "").strip() or None
        print(
            "  [startup-replay] replaying raw messages into typed extraction tables "
            + (f"for tenant={target_tenant}" if target_tenant else "for all tenants"),
            flush=True,
        )
        result = await replay_market_inbox(tenant_id=target_tenant)
        print(
            "  [startup-replay] complete: "
            f"scanned={result.get('scanned', 0)} "
            f"skipped_existing={result.get('skipped_existing', 0)} "
            f"replayed={result.get('replayed', 0)} "
            f"resolved={result.get('resolved', 0)} "
            f"unresolved={result.get('unresolved', 0)} "
            f"errors={result.get('errors', 0)}",
            flush=True,
        )
    except Exception as exc:
        print(f"  [startup-replay] failed: {exc.__class__.__name__}: {exc}", flush=True)
    finally:
        try:
            if lock_fd is not None:
                os.close(lock_fd)
        except Exception:
            pass


app = FastAPI(
    title="PropAI Local Intelligence Lab",
    version="0.1.0",
    lifespan=lifespan,
    docs_url="/docs",
    redoc_url="/redoc",
)

_request_limiter = SlidingWindowLimiter()
_GENERAL_RATE = max(1, int(os.getenv("PROPAI_RATE_LIMIT_PER_MINUTE", "240")))
_SEARCH_RATE = max(1, int(os.getenv("PROPAI_SEARCH_RATE_LIMIT_PER_MINUTE", "60")))
_CHAT_RATE = max(1, int(os.getenv("PROPAI_CHAT_RATE_LIMIT_PER_MINUTE", "30")))
_EXPORT_RATE = max(1, int(os.getenv("PROPAI_EXPORT_RATE_LIMIT_PER_MINUTE", "10")))


@app.middleware("http")
async def request_protection(request: Request, call_next):
    """Bound request bursts before they become DB/provider bursts.

    This is deliberately conservative and process-local.  A shared edge or
    Redis limiter should enforce the same policy across multiple API
    instances; this still protects each instance during a burst or outage.
    """
    path = request.url.path
    if path.startswith("/api/") and request.method not in {"OPTIONS", "HEAD"}:
        if "/chat" in path or "/self-chat" in path:
            bucket, limit = "chat", _CHAT_RATE
        elif "export" in path or path.endswith("/csv"):
            bucket, limit = "export", _EXPORT_RATE
        elif "/search" in path or "/market" in path:
            bucket, limit = "search", _SEARCH_RATE
        else:
            bucket, limit = "general", _GENERAL_RATE
        allowed, remaining, retry_after = _request_limiter.allow(
            request_identity(request), bucket, limit
        )
        if not allowed:
            return JSONResponse(
                {"error": "rate_limit_exceeded", "message": "Too many requests. Please retry shortly."},
                status_code=429,
                headers={"Retry-After": str(retry_after), "X-RateLimit-Limit": str(limit), "X-RateLimit-Remaining": "0"},
            )
        response = await call_next(request)
        response.headers["X-RateLimit-Limit"] = str(limit)
        response.headers["X-RateLimit-Remaining"] = str(remaining)
        return response
    return await call_next(request)

# The dashboard normally proxies API calls through its own Next.js server.
# A session reset deliberately calls the API origin directly: a linked-device
# wipe must not be made unreliable by an intermediate app-server connection.
# Keep this narrowly scoped to the configured dashboard origin (plus local
# development), and allow the bearer-token headers used by the dashboard.
_cors_origins = {
    origin.rstrip("/")
    for origin in (
        FRONTEND_URL,
        "https://app.propai.live",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
    )
    if origin
}
app.add_middleware(
    CORSMiddleware,
    allow_origins=sorted(_cors_origins),
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-Tenant-Id"],
)


# ── Router includes ────────────────────────────────────────────────
app.include_router(infra_router)

from business_api import router as business_api_router
app.include_router(business_api_router)

from routers.business_api import router as business_api_admin_router
app.include_router(business_api_admin_router)

from routers.buildings import router as buildings_router
app.include_router(buildings_router)

from routers.audit import router as audit_router
app.include_router(audit_router)

from routers.groups_market import router as groups_market_router
app.include_router(groups_market_router)
from routers.whatsapp_group_controls import router as onboarding_router
app.include_router(onboarding_router)

from routers.admin import router as admin_router
app.include_router(admin_router)

from routers.admin_ops import router as admin_ops_router
from routers.openclaw_ops import router as openclaw_ops_router
from routers.social_flow import router as social_flow_router
app.include_router(admin_ops_router)
app.include_router(openclaw_ops_router)
app.include_router(social_flow_router)

from routers.auth_org import router as auth_org_router
app.include_router(auth_org_router)

from routers.workspace import router as workspace_router
app.include_router(workspace_router)

from routers.auto_matched import router as auto_matched_router
app.include_router(auto_matched_router)

from routers.clients import router as clients_router
app.include_router(clients_router)

from routers.crm import router as crm_router
app.include_router(crm_router)

from routers.google_drive import router as google_drive_router
app.include_router(google_drive_router)

from routers.whatsapp_sync import router as whatsapp_sync_router
app.include_router(whatsapp_sync_router)

from routers.phone_directory import router as phone_directory_router
app.include_router(phone_directory_router)

from routers.send import router as send_router
app.include_router(send_router)

from routers.self_chat import router as self_chat_router
app.include_router(self_chat_router)

from routers.ai_chat import router as ai_chat_router
app.include_router(ai_chat_router)

from routers.dashboard import router as dashboard_router
app.include_router(dashboard_router)


from routers.brokers import router as brokers_router
app.include_router(brokers_router)

from routers.listings import router as listings_router
app.include_router(listings_router)

from routers.architecture import router as architecture_router
app.include_router(architecture_router)

from routers.search import router as search_router
app.include_router(search_router)

from routers.notes import router as notes_router
app.include_router(notes_router)

from routers.lead_ingestion import router as lead_ingestion_router
app.include_router(lead_ingestion_router)


# ── Global exception handler ───────────────────────────────────────
@app.exception_handler(Exception)
async def global_exception_handler(request, exc):
    import traceback
    tb = traceback.format_exc()
    print(f"[global] unhandled: {exc}\n{tb}", flush=True)
    return JSONResponse(
        status_code=500,
        content={"error": str(exc)[:500], "line": tb.splitlines()[-3] if len(tb.splitlines()) >= 3 else ""},
    )


@app.get("/health")
async def health():
    return {"status": "ok"}


# ═══════════════════════════════════════════════════════════════════
# Background task functions
# ═══════════════════════════════════════════════════════════════════

async def _run_provider_probe_and_log(provider_row: dict) -> None:
    api_key = provider_row.get("api_key") or ""
    base_url = provider_row.get("base_url") or ""
    model_name = provider_row.get("model_name") or ""
    pid = int(provider_row.get("id") or 0)
    pname = str(provider_row.get("provider_name") or "unknown")
    try:
        result = await _probe_provider(api_key, base_url, model_name, timeout_s=15.0)
    except Exception as exc:
        result = {"status": "error", "latency_ms": 0, "http_status": None,
                  "error_kind": type(exc).__name__, "error_msg": str(exc)[:200]}
    event = ProviderOutageEvent(
        provider_id=pid, provider_name=pname,
        provider_type=str(provider_row.get("provider_type") or "unknown"),
        model_name=model_name, status=result["status"], latency_ms=result["latency_ms"],
        http_status=result["http_status"] or 0, error_kind=result["error_kind"] or "",
        error_msg=result["error_msg"] or "",
    )
    try:
        await asyncio.to_thread(storage.insert_provider_outage_event, event)
    except Exception as exc:
        print(f"  [provider-probe] FAILED to log result for {pname} (id={pid}): {exc.__class__.__name__}: {str(exc)[:200]}")


async def _provider_probe_loop() -> None:
    await asyncio.sleep(10)
    while True:
        try:
            providers = await asyncio.to_thread(storage.list_all_llm_providers)
            if providers:
                await asyncio.gather(
                    *[_run_provider_probe_and_log(p) for p in providers],
                    return_exceptions=True,
                )
        except Exception as exc:
            print(f"  [provider-probe] loop error: {exc.__class__.__name__}: {exc}")
        await asyncio.sleep(PROVIDER_PROBE_INTERVAL_S)


async def _history_backfill_loop() -> None:
    await asyncio.sleep(60)
    while True:
        try:
            urls = _ingestor_urls()
            if urls:
                async with httpx.AsyncClient(timeout=45) as client:
                    for base_url in urls:
                        try:
                            resp = await client.post(
                                f"{base_url}/history/backfill",
                                params={"broker_id": "default", "limit": 50, "count": 50},
                                headers=_ingestor_auth_headers(),
                            )
                            body = resp.json() if resp.headers.get("content-type", "").startswith("application/json") else {}
                            if resp.status_code < 300 and body.get("ok"):
                                print(f"  [history-backfill] requested={body.get('requested',0)} skipped={body.get('skipped',0)} via {base_url}")
                            else:
                                print(f"  [history-backfill] {base_url} returned {resp.status_code}: {body.get('error', body)}")
                        except httpx.RequestError as e:
                            print(f"  [history-backfill] {base_url} unreachable: {e}")
        except Exception as exc:
            print(f"  [history-backfill] loop error: {exc.__class__.__name__}: {exc}")
        await asyncio.sleep(HISTORY_BACKFILL_INTERVAL_S)


def _process_enrichment_job(storage, job: dict) -> None:
    from worker import enrich_observation
    enrich_observation(storage, job)


async def _enrichment_loop() -> None:
    await asyncio.sleep(15)
    cycle = 0
    while True:
        cycle += 1
        try:
            if storage is None or not hasattr(storage, "client"):
                await asyncio.sleep(ENRICHMENT_POLL_INTERVAL)
                continue
            recovered = await asyncio.to_thread(storage.recover_stale_enrichment_jobs, 600)
            if recovered:
                print(f"  [enrichment] recovered {recovered} stale jobs", flush=True)
            jobs = await asyncio.to_thread(storage.get_pending_enrichment_jobs, limit=ENRICHMENT_BATCH_SIZE)
            if not jobs:
                if cycle % 10 == 0:
                    print(f"  [enrichment] cycle {cycle}: no pending jobs", flush=True)
                await asyncio.sleep(ENRICHMENT_POLL_INTERVAL)
                continue
            print(f"  [enrichment] cycle {cycle}: {len(jobs)} pending jobs fetched", flush=True)
            processed = 0; skipped = 0
            for job in jobs:
                claimed = await asyncio.to_thread(storage.claim_enrichment_job, job["id"])
                if not claimed:
                    skipped += 1; continue
                try:
                    await asyncio.to_thread(_process_enrichment_job, storage, job)
                    await asyncio.to_thread(storage.complete_enrichment_job, job["id"])
                    processed += 1
                except Exception as e:
                    print(f"  [enrichment] job {job['id']} failed: {e}", flush=True)
                    await asyncio.to_thread(storage.complete_enrichment_job, job["id"], error=str(e))
            print(f"  [enrichment] cycle {cycle}: processed={processed} skipped={skipped}", flush=True)
        except Exception as exc:
            print(f"  [enrichment] loop error: {exc.__class__.__name__}: {exc}", flush=True)
        await asyncio.sleep(ENRICHMENT_POLL_INTERVAL)


# ═══════════════════════════════════════════════════════════════════
# Monkeypatch wiring — set module-level references on each router
# ═══════════════════════════════════════════════════════════════════

from routers.dashboard import _today_prefix as __today_prefix

import routers.ai_chat as _ai_chat_mod
_ai_chat_mod.get_embedder = get_embedder
_ai_chat_mod._today_prefix = __today_prefix

import routers.audit as _audit_mod
_audit_mod._group_jid_to_name = _group_jid_to_name
_audit_mod._table_exists = _table_exists
_audit_mod._audit_rows = _audit_rows
_audit_mod._audit_row_value = _audit_row_value
_audit_mod._audit_scalar = _audit_scalar
_audit_mod._audit_count = _audit_count
_audit_mod._audit_timestamp = _audit_timestamp
_audit_mod._audit_group_display_name = _audit_group_display_name
_audit_mod._audit_buildings_for_group = _audit_buildings_for_group
_audit_mod._clean_audit_building_name = _clean_audit_building_name
_audit_mod._AUDIT_BUILDING_LABEL_PATTERN = _AUDIT_BUILDING_LABEL_PATTERN
_audit_mod._AUDIT_BUILDING_PLACEHOLDERS = _AUDIT_BUILDING_PLACEHOLDERS
_audit_mod._count_table = _count_table
_audit_mod.parse_group_name = parse_group_name

import routers.dashboard
routers.dashboard._load_evidence_cache = _load_evidence_cache
routers.dashboard._broker_live_statuses = _broker_live_statuses
routers.dashboard._merged_ingestor_list = _merged_ingestor_list
routers.dashboard._first_ingestor_response = _first_ingestor_response
routers.dashboard.business_window_status = business_window_status
routers.dashboard.get_scheduler = get_scheduler
routers.dashboard._count_table = _count_table
routers.dashboard._today_count = _today_count

import routers.listings
routers.listings.MEDIA_DIR = MEDIA_DIR

import routers.admin
routers.admin._merged_ingestor_list = _merged_ingestor_list
routers.admin._admin_whatsapp_session = _admin_whatsapp_session
routers.admin._first_ingestor_response = _first_ingestor_response
routers.admin._summarise_provider = _summarise_provider
routers.admin._bucket_history = _bucket_history
routers.admin._probe_provider = _probe_provider

import routers.auth_org
routers.auth_org._first_ingestor_response = _first_ingestor_response
routers.auth_org._ingestor_urls = _ingestor_urls
routers.auth_org._ingestor_auth_headers = _ingestor_auth_headers

import routers.workspace
routers.workspace._probe_provider = _probe_provider
routers.workspace._connection_details = _connection_details
routers.workspace._market_sync_ready = _market_sync_ready
routers.workspace._merged_ingestor_list = _merged_ingestor_list
routers.workspace._broker_live_statuses = _broker_live_statuses
routers.workspace._first_ingestor_response = _first_ingestor_response
routers.workspace._table_exists = _table_exists
routers.workspace._count_table = _count_table
routers.workspace._business_api_get_config_value = _business_api_get_config_value

import routers.whatsapp_sync
routers.whatsapp_sync._broker_live_statuses = _broker_live_statuses
routers.whatsapp_sync._ingestor_urls = _ingestor_urls
routers.whatsapp_sync._ingestor_auth_headers = _ingestor_auth_headers
routers.whatsapp_sync._first_ingestor_response = _first_ingestor_response
routers.whatsapp_sync._best_ingestor_status_for_broker = _best_ingestor_status_for_broker
routers.whatsapp_sync._merged_ingestor_list = _merged_ingestor_list
routers.whatsapp_sync._ingestor_failure_message = _ingestor_failure_message
routers.whatsapp_sync._memory_status = _memory_status
routers.whatsapp_sync._previous_status = _previous_status
routers.whatsapp_sync._cache_connection_snapshot = _cache_connection_snapshot

import routers.phone_directory
routers.phone_directory._first_ingestor_response = _first_ingestor_response
routers.whatsapp_sync._platform_waba_values = _platform_waba_values
routers.whatsapp_sync._workspace_waba_values = _workspace_waba_values
routers.whatsapp_sync._resolve_waba_webhook_config = _resolve_waba_webhook_config
routers.whatsapp_sync._process_business_api_webhook = _process_business_api_webhook
routers.whatsapp_sync._waba_session_update = _waba_session_update
routers.whatsapp_sync._waba_session_status = _waba_session_status
routers.whatsapp_sync._waba_send_message = _waba_send_message
routers.whatsapp_sync._business_api_config_for = _business_api_config_for
routers.whatsapp_sync._business_api_set_config_value = _business_api_set_config_value
routers.whatsapp_sync._business_api_member = _business_api_member
routers.whatsapp_sync._is_propai_shared_waba = _is_propai_shared_waba
routers.whatsapp_sync._mobile_digits = _mobile_digits
routers.whatsapp_sync._business_api_get_config_value = _business_api_get_config_value
routers.whatsapp_sync._mask_secret = _mask_secret
routers.whatsapp_sync._waba_callback_url = _waba_callback_url
routers.whatsapp_sync._download_waba_media = _download_waba_media
routers.whatsapp_sync._display_phone_from_whatsapp_id = _display_phone_from_whatsapp_id
routers.whatsapp_sync.get_scheduler = get_scheduler

import routers.send
routers.send._ingestor_auth_headers = _ingestor_auth_headers
routers.send._notify_broker_of_lead = _notify_broker_of_lead

import routers.business_api
routers.business_api._count_table = _count_table
routers.business_api._today_count = _today_count
routers.business_api._platform_waba_values = _platform_waba_values
routers.business_api._workspace_waba_values = _workspace_waba_values
routers.business_api._business_api_member = _business_api_member
routers.business_api._mobile_digits = _mobile_digits
routers.business_api._is_propai_shared_waba = _is_propai_shared_waba
routers.business_api._business_api_get_config_value = _business_api_get_config_value
routers.business_api._mask_secret = _mask_secret
routers.business_api._waba_callback_url = _waba_callback_url
routers.business_api._waba_session_update = _waba_session_update
routers.business_api._waba_session_status = _waba_session_status


# ── Backward-compatible re-exports for tests ─────────────────────
from routers.common import (
    verify_supabase_token, get_tenant_context, get_current_user,
    _resolve_user_organization_id,
    _parse_event_ts, _bucket_history, _classify_provider_status,
    _summarise_provider, _connection_details, _audit_group_display_name,
    _audit_timestamp, _audit_buildings_for_group, _clean_audit_building_name,
    _mobile_digits, _probe_provider, PROPAI_SHARED_WABA_NUMBER,
    PROBE_OK_LATENCY_THRESHOLD_MS, _resolve_waba_webhook_config,
)
from routers.infra import (
    parse_message, resolve_parsed, evaluate_parsed,
    compute_embedding, generate_summary_title,
    _infer_micro_market, _parsed_source_text, _demote_weak_property_parse,
    _parsed_has_market_anchor,
    _classify_webhook_event, _process_single_raw, _schedule_raw_extraction,
    _whatsapp_attachment_metadata, _whatsapp_message_text,
    _whatsapp_message_type, _EXTRACTION_SLOTS,
)
from routers.ai_chat import _ai_promote


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("lab.app:app", host=HOST, port=PORT, reload=True)
