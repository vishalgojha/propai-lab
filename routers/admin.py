"""Admin routes (super-admin gated)."""
import asyncio
import time
from datetime import datetime, timezone
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException

from routers.common import storage, require_user
from storage import ProviderOutageEvent

router = APIRouter(tags=["admin"])

# Placeholders set by app.py at startup
_merged_ingestor_list = None
_admin_whatsapp_session = None
_first_ingestor_response = None
_summarise_provider = None
_bucket_history = None
_probe_provider = None


@router.get("/api/admin/whatsapp/sessions")
async def admin_list_whatsapp_sessions(user: dict = Depends(require_user)):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin access required")
    phones = await asyncio.to_thread(storage.list_all_whatsapp_connections)
    statuses, _, _ = await _merged_ingestor_list(timeout=3)
    sessions = [
        await _admin_whatsapp_session(
            phone, statuses.get(str(phone.get("broker_id") or ""), {})
        )
        for phone in phones
    ]
    return {"sessions": sessions}


@router.patch("/api/admin/whatsapp/sessions/{phone_id}")
async def admin_update_whatsapp_session(
    phone_id: int, body: dict, user: dict = Depends(require_user)
):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin access required")
    phone = await asyncio.to_thread(storage.get_whatsapp_connection_unscoped, phone_id)
    if not phone:
        raise HTTPException(404, "Phone not found")
    allowed = {"instance_name", "is_active", "self_chat_enabled", "extraction_status"}
    updates = {key: body[key] for key in allowed if key in body}
    for key in ("is_active", "self_chat_enabled"):
        if key in updates and not isinstance(updates[key], bool):
            raise HTTPException(400, f"{key} must be a boolean")
    if "instance_name" in updates:
        updates["instance_name"] = str(updates["instance_name"]).strip()[:100]
    if "extraction_status" in updates:
        status = str(updates["extraction_status"] or "").strip().lower()
        if status not in {"paused", "stopped"}:
            raise HTTPException(400, "Super-admin session controls may only pause or stop extraction")
        updates["extraction_status"] = status
    if not updates:
        raise HTTPException(400, "No valid fields to update")
    updates["updated_at"] = datetime.now(timezone.utc).isoformat()
    result = await asyncio.to_thread(storage.update_org_whatsapp_connection, phone_id, updates)
    if updates.get("is_active") is False:
        broker_id = str(phone.get("broker_id") or "").strip()
        if broker_id:
            await _first_ingestor_response(
                "POST", "/disconnect", timeout=10, headers={"X-Broker-Id": broker_id}
            )
    return await _admin_whatsapp_session(result or phone)


@router.get("/api/admin/orgs")
async def admin_list_organizations(
    limit: int = 100, offset: int = 0,
    user: dict = Depends(require_user),
):
    if not storage.is_super_admin(user["id"]):
        raise HTTPException(403, "Super admin access required")
    return storage.list_organizations(limit, offset)


@router.get("/api/admin/stats")
async def admin_stats(user: dict = Depends(require_user)):
    if not storage.is_super_admin(user["id"]):
        raise HTTPException(403, "Super admin access required")
    orgs = storage.list_organizations(limit=1000)
    return {
        "total_organizations": len(orgs),
        "total_active": sum(1 for o in orgs if o.get("is_active")),
        "organizations": orgs,
    }


@router.get("/api/admin/super-admins")
async def list_super_admins(user: dict = Depends(require_user)):
    if not storage.is_super_admin(user["id"]):
        raise HTTPException(403, "Super admin access required")
    return storage.list_super_admins()


@router.post("/api/admin/super-admins")
async def add_super_admin_endpoint(body: dict, user: dict = Depends(require_user)):
    if not storage.is_super_admin(user["id"]):
        raise HTTPException(403, "Super admin access required")
    user_id = body.get("user_id")
    if not user_id:
        raise HTTPException(400, "user_id is required")
    result = storage.add_super_admin(user_id, body.get("phone", ""))
    if not result:
        raise HTTPException(400, "Failed to add super admin")
    return result


@router.delete("/api/admin/super-admins/{user_id}")
async def remove_super_admin_endpoint(user_id: str, user: dict = Depends(require_user)):
    if not storage.is_super_admin(user["id"]):
        raise HTTPException(403, "Super admin access required")
    ok = storage.remove_super_admin(user_id)
    if not ok:
        raise HTTPException(404, "Super admin not found")
    return {"ok": True}


@router.get("/api/admin/ai-usage")
async def admin_ai_usage(days: int = 7, user: dict = Depends(require_user)):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    return storage.get_ai_usage_stats(days=min(max(days, 1), 90))


@router.get("/api/admin/extraction-progress")
async def admin_extraction_progress(
    hours: int = 24,
    user: dict = Depends(require_user),
):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    return storage.get_extraction_progress(
        rate_window_hours=min(max(hours, 1), 168),
        tenant_id=None,
    )


def _repair_context(raw: dict) -> dict:
    """Reconstruct the extraction context without mutating the WhatsApp event."""
    payload = raw.get("raw_payload")
    if isinstance(payload, str):
        try:
            import json
            payload = json.loads(payload)
        except Exception:
            payload = {}
    return {
        "msg_text": str(raw.get("message") or ""),
        "sender_name": str(raw.get("sender") or ""),
        "push_name": str(raw.get("sender") or ""),
        "sender_jid": str(raw.get("sender_jid") or ""),
        "sender_phone": str(raw.get("sender_phone") or ""),
        "group": str(raw.get("group_name") or ""),
        "group_name": str(raw.get("group_name") or ""),
        "instance": "",
        "is_dm": not bool(raw.get("is_group")),
        "is_group": bool(raw.get("is_group")),
        "message_uid": raw.get("message_uid") or str(raw.get("id") or ""),
        "message_id": raw.get("event_id") or "",
        "raw_payload": payload if isinstance(payload, dict) else {},
        "timestamp": raw.get("timestamp") or raw.get("created_at") or "",
        "source": raw.get("source") or "WHATSAPP",
        "tenant_id": raw.get("tenant_id"),
        "pipeline_version": raw.get("pipeline_version"),
        "synced_at": raw.get("synced_at"),
        "event_id": raw.get("event_id") or "",
    }


@router.get("/api/admin/extraction-repair")
async def admin_extraction_repair_status(user: dict = Depends(require_user)):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    try:
        return await asyncio.to_thread(storage.get_extraction_repair_status)
    except Exception as exc:
        raise HTTPException(503, "Extraction repair evidence is temporarily unavailable") from exc


@router.post("/api/admin/extraction-repair/run")
async def admin_run_extraction_repair(body: dict, user: dict = Depends(require_user)):
    """Queue deterministic child slices for historical unsliced parents.

    This endpoint never calls an LLM. It is safe to repeat: the child UID and
    repair-job unique key make reruns idempotent.
    """
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    try:
        from deterministic_splitters import parse_message
        from extraction import _materialize_split_raw_messages
    except Exception as exc:
        raise HTTPException(503, "Extraction splitter is unavailable") from exc
    limit = max(1, min(int(body.get("limit") or 25), 100))
    dry_run = bool(body.get("dry_run", False))
    requested_raw_id = body.get("raw_id")
    if requested_raw_id is not None:
        raw = await asyncio.to_thread(storage.get_raw_message, int(requested_raw_id))
        candidates = [raw.__dict__] if raw and raw.processed and not raw.parent_message_id and not raw.extraction_superseded else []
    else:
        candidates = await asyncio.to_thread(storage.list_extraction_repair_candidates, limit=limit * 4)
    preview = []
    repaired = []
    for raw in candidates:
        text = str(raw.get("message") or "")
        if not text.strip():
            continue
        pattern, chunks = parse_message(text)
        item = {"raw_id": int(raw.get("id") or 0), "pattern_id": pattern, "chunk_count": len(chunks)}
        if not pattern or len(chunks) < 2:
            item["status"] = "no_split"
            preview.append(item)
            continue
        item["status"] = "repairable"
        preview.append(item)
        if dry_run or len(repaired) >= limit:
            continue
        job = await asyncio.to_thread(
            storage.upsert_extraction_repair_job,
            int(raw["id"]),
            tenant_id=raw.get("tenant_id"),
            requested_by=user.get("id"),
            existing_parsed_count=1 if await asyncio.to_thread(storage.get_parsed_by_raw, int(raw["id"])) else 0,
        )
        ctx = _repair_context(raw)
        ctx["split_pattern"] = pattern
        try:
            child_ids = await asyncio.to_thread(storage_materialize_repair, storage, int(raw["id"]), ctx, chunks, _materialize_split_raw_messages)
            if len(child_ids) != len(chunks):
                await asyncio.to_thread(storage.update_extraction_repair_job, int(job["id"]), status="failed", error=f"expected {len(chunks)} children, got {len(child_ids)}")
                continue
            await asyncio.to_thread(storage.mark_raw_extraction_superseded, int(raw["id"]), int(job["id"]))
            await asyncio.to_thread(storage.mark_raw_processed, int(raw["id"]))
            await asyncio.to_thread(storage.update_extraction_repair_job, int(job["id"]), status="queued", pattern_id=pattern, child_raw_ids=child_ids)
            repaired.append({"raw_id": int(raw["id"]), "job_id": int(job["id"]), "child_raw_ids": child_ids, "pattern_id": pattern})
        except Exception as exc:
            await asyncio.to_thread(storage.update_extraction_repair_job, int(job["id"]), status="failed", error=str(exc)[:500])
    return {"dry_run": dry_run, "preview": preview[:limit], "repaired": repaired, "repaired_count": len(repaired)}


def storage_materialize_repair(storage_obj, raw_id, ctx, chunks, materializer):
    return materializer(storage_obj, raw_id, ctx, chunks)


@router.get("/api/admin/semantic-embeddings")
async def admin_semantic_embeddings(user: dict = Depends(require_user)):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    try:
        return await asyncio.to_thread(storage.get_semantic_embedding_status)
    except Exception as exc:
        raise HTTPException(503, "Semantic embedding evidence is temporarily unavailable") from exc


@router.post("/api/admin/semantic-embeddings/probe")
async def admin_semantic_embedding_probe(body: dict, user: dict = Depends(require_user)):
    """Run a real semantic query so an operator can inspect retrieval quality."""
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    query = str(body.get("query") or "").strip()
    if len(query) < 2:
        raise HTTPException(400, "Enter at least two characters to probe semantic retrieval")
    if len(query) > 500:
        raise HTTPException(400, "Probe query must be 500 characters or fewer")
    requested_types = body.get("entity_types")
    entity_types = None
    if requested_types is not None:
        if not isinstance(requested_types, list):
            raise HTTPException(400, "entity_types must be a list")
        allowed = {"listing", "requirement", "building", "building_alias", "locality", "broker", "broker_alias"}
        entity_types = [str(value) for value in requested_types if str(value) in allowed]
        if not entity_types:
            raise HTTPException(400, "entity_types contains no supported entity types")
    try:
        from semantic_embeddings import semantic_search

        results = await asyncio.to_thread(
            semantic_search,
            storage,
            query,
            entity_types=entity_types,
            limit=10,
            min_similarity=0.25,
        )
    except Exception as exc:
        raise HTTPException(503, "Semantic retrieval probe is temporarily unavailable") from exc
    return {"query": query, "results": results}


_SEMANTIC_EVAL_SOURCES = {
    "listing": {
        "residential_sale_listings", "residential_rent_listings",
        "commercial_sale_listings", "commercial_rent_listings",
    },
    "requirement": {
        "residential_sale_requirements", "residential_rent_requirements",
        "commercial_sale_requirements", "commercial_rent_requirements",
    },
    "building": {"buildings"},
    "building_alias": {"building_name_aliases"},
    "locality": {"locality_reference"},
    "broker": {"brokers"},
    "broker_alias": {"broker_aliases"},
}


@router.get("/api/admin/semantic-embeddings/evals")
async def admin_semantic_embedding_evals(user: dict = Depends(require_user)):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    return await asyncio.to_thread(storage.list_semantic_retrieval_eval_cases, True)


@router.get("/api/admin/building-enrichment/worker")
async def admin_building_enrichment_worker(user: dict = Depends(require_user)):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    try:
        # The project REST client returns decoded JSON directly; it does not
        # expose the supabase-py response object's execute()/data API.
        result = await asyncio.to_thread(
            storage.client.rpc, "get_building_enrichment_worker_evidence", {}
        )
        return result or {}
    except Exception as exc:
        import logging
        logging.getLogger(__name__).exception(
            "Building enrichment worker evidence lookup failed"
        )
        raise HTTPException(503, "Building enrichment worker evidence is temporarily unavailable") from exc


def _redact_phone_like_text(value: object) -> str:
    """Keep gate evidence useful without exposing phone numbers in admin HTML."""
    import re

    text = str(value or "")
    return re.sub(r"(?<!\d)(?:\+?\d[\d\s().-]{7,}\d)(?!\d)", "[contact redacted]", text)


@router.get("/api/admin/dedupe-gate")
async def admin_dedupe_gate(
    limit: int = 50,
    decision: str = "all",
    user: dict = Depends(require_user),
):
    """Show durable evidence for messages stopped by the author-copy gate."""
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")

    limit = min(max(int(limit or 50), 1), 100)
    decision = str(decision or "all").strip().lower()
    if decision not in {"all", "repeat_observation"}:
        raise HTTPException(400, "Unsupported gate decision")

    try:
        query = storage.client.table("raw_messages").select(
            "id,group_name,sender,sender_jid,sender_phone,message,timestamp,created_at,"
            "author_content_fingerprint,repeat_of_raw_message_id,processed_at,extraction_outcome"
        ).not_.is_("repeat_of_raw_message_id", "null").order("timestamp", desc=True).limit(limit)
        if decision == "repeat_observation":
            query = query.eq("extraction_outcome", "repeat_observation")
        rows = await asyncio.to_thread(lambda: query.execute().data or [])

        original_ids = sorted({int(row["repeat_of_raw_message_id"]) for row in rows if row.get("repeat_of_raw_message_id")})
        originals: dict[int, dict] = {}
        if original_ids:
            original_rows = await asyncio.to_thread(
                lambda: storage.client.table("raw_messages").select(
                    "id,group_name,timestamp,message,author_content_fingerprint"
                ).in_("id", original_ids).execute().data or []
            )
            originals = {int(row["id"]): row for row in original_rows}

        def summarize(row: dict) -> dict:
            original = originals.get(int(row.get("repeat_of_raw_message_id") or 0), {})
            return {
                "raw_id": row.get("id"),
                "decision": row.get("extraction_outcome") or "repeat_observation",
                "reason": "same resolved author + identical normalized content fingerprint",
                "fingerprint": row.get("author_content_fingerprint"),
                "received_at": row.get("timestamp") or row.get("created_at"),
                "processed_at": row.get("processed_at"),
                "group_jid": row.get("group_name"),
                "sender": _redact_phone_like_text(row.get("sender") or row.get("sender_jid")),
                "message_preview": _redact_phone_like_text(str(row.get("message") or "").strip()[:240]),
                "repeat_of_raw_id": row.get("repeat_of_raw_message_id"),
                "original": {
                    "raw_id": original.get("id"),
                    "group_jid": original.get("group_name"),
                    "received_at": original.get("timestamp"),
                    "fingerprint": original.get("author_content_fingerprint"),
                    "message_preview": _redact_phone_like_text(str(original.get("message") or "").strip()[:240]),
                } if original else None,
            }

        total_query = storage.client.table("raw_messages").select("id", count="exact").not_.is_("repeat_of_raw_message_id", "null")
        if decision == "repeat_observation":
            total_query = total_query.eq("extraction_outcome", "repeat_observation")
        total_result = await asyncio.to_thread(total_query.execute)
        return {
            "total": int(getattr(total_result, "count", 0) or 0),
            "returned": len(rows),
            "decisions": {"repeat_observation": int(getattr(total_result, "count", 0) or 0)},
            "items": [summarize(row) for row in rows],
        }
    except Exception as exc:
        import logging
        logging.getLogger(__name__).exception("Dedupe gate evidence lookup failed")
        raise HTTPException(503, "Dedupe gate evidence is temporarily unavailable") from exc


@router.get("/api/admin/semantic-embeddings/evals/summary")
async def admin_semantic_embedding_eval_summary(user: dict = Depends(require_user)):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    return await asyncio.to_thread(storage.get_latest_semantic_retrieval_eval_run)


@router.post("/api/admin/semantic-embeddings/evals")
async def admin_create_semantic_embedding_eval(body: dict, user: dict = Depends(require_user)):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    query = str(body.get("query") or "").strip()
    entity_type = str(body.get("entity_type") or "").strip()
    target_entity_type = str(body.get("target_entity_type") or entity_type).strip()
    source_table = str(body.get("source_table") or "").strip()
    target_source_table = str(body.get("target_source_table") or source_table).strip()
    try:
        source_id = int(body.get("source_id"))
    except (TypeError, ValueError):
        raise HTTPException(400, "source_id must be a positive integer")
    try:
        top_k = max(1, min(int(body.get("top_k") or 5), 20))
    except (TypeError, ValueError):
        raise HTTPException(400, "top_k must be an integer between 1 and 20")
    if len(query) < 2 or len(query) > 500:
        raise HTTPException(400, "query must be between 2 and 500 characters")
    if (
        entity_type not in _SEMANTIC_EVAL_SOURCES
        or target_entity_type not in _SEMANTIC_EVAL_SOURCES
        or source_table not in _SEMANTIC_EVAL_SOURCES[entity_type]
        or target_source_table not in _SEMANTIC_EVAL_SOURCES[target_entity_type]
    ):
        raise HTTPException(400, "entity_type and source_table do not form a supported pair")
    if source_id <= 0:
        raise HTTPException(400, "source_id must be a positive integer")
    try:
        target_source_id = int(body.get("target_source_id") or source_id)
    except (TypeError, ValueError):
        raise HTTPException(400, "target_source_id must be a positive integer")
    if target_source_id <= 0:
        raise HTTPException(400, "target_source_id must be a positive integer")
    tenant_id = body.get("tenant_id")
    if tenant_id:
        try:
            tenant_id = str(UUID(str(tenant_id)))
        except ValueError:
            raise HTTPException(400, "tenant_id must be a UUID")
    try:
        return await asyncio.to_thread(storage.create_semantic_retrieval_eval_case, {
            "tenant_id": tenant_id,
            "query": query,
            "entity_type": entity_type,
            "target_entity_type": target_entity_type,
            "source_table": source_table,
            "source_id": source_id,
            "target_source_table": target_source_table,
            "target_source_id": target_source_id,
            "top_k": top_k,
        })
    except Exception as exc:
        if "duplicate key" in str(exc).lower() or "unique constraint" in str(exc).lower():
            raise HTTPException(409, "That retrieval case already exists") from exc
        raise HTTPException(503, "Retrieval evaluation case could not be saved") from exc


@router.post("/api/admin/semantic-embeddings/evals/run")
async def admin_run_semantic_embedding_evals(user: dict = Depends(require_user)):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    try:
        from semantic_embeddings import run_semantic_retrieval_evals

        return await asyncio.to_thread(run_semantic_retrieval_evals, storage)
    except Exception as exc:
        raise HTTPException(503, "Retrieval evaluation run is temporarily unavailable") from exc


@router.delete("/api/admin/semantic-embeddings/evals/{case_id}")
async def admin_delete_semantic_embedding_eval(case_id: int, user: dict = Depends(require_user)):
    if not await asyncio.to_thread(storage.is_super_admin, user["id"]):
        raise HTTPException(403, "Super admin only")
    deleted = await asyncio.to_thread(storage.delete_semantic_retrieval_eval_case, case_id)
    if not deleted:
        raise HTTPException(404, "Retrieval evaluation case not found")
    return {"ok": True}


@router.get("/api/admin/providers/health")
async def admin_provider_health(user: dict = Depends(require_user)):
    providers = await asyncio.to_thread(storage.list_all_llm_providers)
    now_ts = time.time()
    out_providers = []
    worst = "up"
    rank = {"up": 0, "degraded": 1, "unknown": 2, "down": 3}
    for prow in providers:
        pid = int(prow.get("id") or 0)
        events = await asyncio.to_thread(
            storage.list_provider_outage_events_by_provider_id, 30, pid, 200
        )
        summary = _summarise_provider(events, now_ts)
        out_providers.append({
            "provider_id": pid,
            "provider_name": str(prow.get("provider_name") or ""),
            "provider_type": str(prow.get("provider_type") or ""),
            "model_name": str(prow.get("model_name") or ""),
            "base_url": str(prow.get("base_url") or ""),
            "is_active": bool(prow.get("is_active")),
            "tenant_id": prow.get("tenant_id"),
            **summary,
        })
        if rank[summary["status"]] > rank[worst]:
            worst = summary["status"]
    return {
        "providers": out_providers,
        "overall": worst,
        "now_ts": now_ts,
    }


@router.get("/api/admin/providers/history")
async def admin_provider_history(user: dict = Depends(require_user),
                                  hours: int = 24, bucket_minutes: int = 5):
    if hours not in (1, 6, 24, 168):
        hours = 24
    if bucket_minutes not in (1, 5, 15, 60):
        bucket_minutes = 5
    since_minutes = hours * 60
    events = await asyncio.to_thread(
        storage.list_provider_outage_events, since_minutes, None, 5000
    )
    by_row: dict[int, dict] = {}
    for e in events:
        pid = int(e.get("provider_id") or 0)
        if pid not in by_row:
            by_row[pid] = {
                "provider_id": pid,
                "provider_name": e.get("provider_name", "unknown"),
                "events": [],
            }
        by_row[pid]["events"].append(e)
    return {
        "hours": hours,
        "bucket_minutes": bucket_minutes,
        "providers": [
            {
                "provider_id": row["provider_id"],
                "provider_name": row["provider_name"],
                "buckets": _bucket_history(row["events"], bucket_minutes, hours),
            }
            for row in by_row.values()
        ],
    }


@router.post("/api/admin/providers/probe/{provider_id}")
async def admin_provider_probe_now(provider_id: int, user: dict = Depends(require_user)):
    providers = await asyncio.to_thread(storage.list_all_llm_providers)
    target = next((p for p in providers if int(p.get("id") or 0) == provider_id), None)
    if not target:
        return {"probed": False, "error": f"provider_id {provider_id} not found"}
    api_key = str(target.get("api_key") or "")
    base_url = str(target.get("base_url") or "")
    model_name = str(target.get("model_name") or "")
    result = await _probe_provider(api_key, base_url, model_name, timeout_s=15.0)
    event = ProviderOutageEvent(
        provider_id=provider_id,
        provider_name=str(target.get("provider_name") or "unknown"),
        provider_type=str(target.get("provider_type") or "unknown"),
        model_name=model_name,
        status=result["status"],
        latency_ms=result["latency_ms"],
        http_status=result["http_status"] or 0,
        error_kind=result["error_kind"] or "",
        error_msg=result["error_msg"] or "",
    )
    try:
        new_id = await asyncio.to_thread(storage.insert_provider_outage_event, event)
    except Exception as exc:
        return {"probed": False, "error": f"insert failed: {str(exc)[:200]}",
                "probe_result": result}
    return {"probed": True, "inserted_id": new_id, "probe_result": result}


@router.post("/api/admin/providers/cleanup")
async def admin_provider_cleanup(body: dict, user: dict = Depends(require_user)):
    days = int(body.get("retention_days") or 7)
    if days < 1 or days > 90:
        return {"deleted": 0, "error": "retention_days must be between 1 and 90"}
    deleted = await asyncio.to_thread(storage.cleanup_provider_outage_log, days)
    return {"deleted": deleted, "retention_days": days}
