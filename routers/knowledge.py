"""Knowledge graph, observations, and intelligence routes."""
import asyncio
import json
import logging
import re
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from routers.common import storage, require_user, get_tenant_context

router = APIRouter(tags=["knowledge"])

logger = logging.getLogger(__name__)

# ── Pydantic models ──────────────────────────────────────────────────────────

class BatchCreateRequest(BaseModel):
    batch_type: str = "observation_extraction"
    max_messages: int = 0

class BatchCreateResponse(BaseModel):
    id: int
    batch_api_id: str | None = None
    status: str
    total_requests: int
    stats_snapshot: str = ""


# ── Helpers ──────────────────────────────────────────────────────────────────

def _merge_observation(
    entity_type: str,
    entity_name: str,
    observation_type: str,
    observation_text: str,
    broker_name: str,
    broker_phone: str,
    parsed_id: int | None,
    raw_id: int | None,
    now: str,
):
    if storage is None:
        return
    norm_entity = entity_name.strip().lower()
    norm_type = observation_type.strip().lower()
    existing = storage.db.execute(
        """SELECT id, observation_count, observation_text
           FROM knowledge_observations
           WHERE LOWER(entity_name) = ? AND entity_type = ? AND observation_type = ?
             AND source_broker_phone = ?
           ORDER BY id DESC LIMIT 1""",
        (norm_entity, entity_type, norm_type, broker_phone or ""),
    ).fetchone()
    if existing:
        storage.db.execute(
            """UPDATE knowledge_observations
               SET observation_count = observation_count + 1,
                   observation_text = ?,
                   updated_at = ?,
                   source_parsed_id = ?,
                   source_raw_id = ?
               WHERE id = ?""",
            (observation_text, now, parsed_id, raw_id, existing["id"]),
        )
    else:
        confidence = 1
        _count_other_brokers = storage.db.execute(
            """SELECT COUNT(DISTINCT source_broker_phone) as c
               FROM knowledge_observations
               WHERE LOWER(entity_name) = ? AND entity_type = ? AND observation_type = ?
                 AND source_broker_phone IS NOT NULL AND source_broker_phone != ''""",
            (norm_entity, entity_type, norm_type),
        ).fetchone()
        if _count_other_brokers and _count_other_brokers["c"] >= 2:
            confidence = 3
        elif _count_other_brokers and _count_other_brokers["c"] >= 1:
            confidence = 2
        storage.db.execute(
            """INSERT INTO knowledge_observations
               (entity_type, entity_name, observation_type, observation_text,
                confidence, observation_count, source_broker_name, source_broker_phone,
                source_parsed_id, source_raw_id, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)""",
            (entity_type, entity_name.strip(), norm_type, observation_text,
             confidence, broker_name, broker_phone or "", parsed_id, raw_id, now, now),
        )


_LISTING_ONLY_RE = re.compile(
    r'(?i)\b(bhk|sqft|sft|carpet|furnished|unfurnished|possession|parking|deposit|negotiable|available for)\b'
)
_CONVERSATIONAL_RE = re.compile(
    r'(?i)\b(client|view|feedback|problem|issue|like|dislike|suggest|feel|think|say|said|told|mention|notic|facing|faced|facing issue|too small|too big|too costly|expensive|cheap|good|bad|nice|great|worst|better|worse|reject|accept|prefer|want|need|looking for|requirement)\b'
)


def _looks_conversational(text: str) -> bool:
    if len(text) < 50:
        return False
    if _LISTING_ONLY_RE.findall(text) and not _CONVERSATIONAL_RE.search(text):
        return False
    return True


def _iso_now() -> str:
    n = datetime.now(timezone.utc)
    return n.strftime("%Y-%m-%dT%H:%M:%S.") + f"{n.microsecond // 1000:03d}Z"


def _generate_batch_jsonl(max_messages: int = 0) -> tuple[list[dict], str]:
    from ai_chat_engine import _OBSERVATION_PROMPT
    from llm import get_model
    model_name = get_model()
    from lab.config import DOUBLEWORD_API_KEY

    out_dir = Path("/tmp/opencode")
    out_dir.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y%m%d_%H%M%S")
    jsonl_path = str(out_dir / f"obs_batch_{ts}.jsonl")

    rows = storage.db.execute(
        """SELECT id, broker_name, broker_phone, raw_payload
           FROM parsed_output
           WHERE raw_payload IS NOT NULL AND raw_payload != ''
           ORDER BY id"""
    ).fetchall()

    batch_lines = []
    batch_rows = []
    for r in rows:
        try:
            rp = json.loads(r["raw_payload"]) if isinstance(r["raw_payload"], str) else r["raw_payload"]
        except (json.JSONDecodeError, TypeError):
            continue
        text = (rp or {}).get("full_text", "")
        if not text or not _looks_conversational(text):
            continue
        line = {
            "custom_id": f"obs_{r['id']}",
            "method": "POST",
            "url": "/v1/chat/completions",
            "body": {
                "model": model_name,
                "messages": [
                    {"role": "system", "content": _OBSERVATION_PROMPT},
                    {"role": "user", "content": text},
                ],
                "temperature": 0.1,
                "max_tokens": 512,
            },
        }
        batch_lines.append(json.dumps(line))
        batch_rows.append({
            "parsed_id": r["id"],
            "broker_name": r["broker_name"] or "",
            "broker_phone": r["broker_phone"] or "",
            "text_preview": text[:100],
        })
        if max_messages > 0 and len(batch_lines) >= max_messages:
            break

    Path(jsonl_path).write_text("\n".join(batch_lines))
    return batch_rows, jsonl_path


# ── Block 1: Observations Feed ──────────────────────────────────────────────

@router.get("/api/observations/feed")
async def get_observations_feed(
    user: dict = Depends(require_user),
    limit: int = 50, offset: int = 0,
    broker_key: str = "", intent: str = "",
    phone: str = "",
    tenant_id: str | None = Depends(get_tenant_context),
):
    bk = broker_key or phone
    return storage.get_observations_feed(
        limit,
        offset,
        broker_key=bk,
        intent=intent,
        tenant_id=tenant_id,
    )


# ── Block 2: Single Observation ─────────────────────────────────────────────

@router.get("/api/observations/{obs_id}")
async def get_observation(obs_id: int, user: dict = Depends(require_user)):
    result = storage.get_observation_detail(obs_id)
    if not result.get("raw"):
        raise HTTPException(404, "Observation not found")
    return result


# ── Block 3: Knowledge Observations API ─────────────────────────────────────

@router.get("/api/knowledge/observations")
async def get_knowledge_observations(
    user: dict = Depends(require_user),
    entity_type: str = "",
    entity_name: str = "",
    broker_phone: str = "",
    limit: int = 50,
):
    if storage is None:
        return []
    clauses = []
    params: list = []
    if entity_type:
        clauses.append("entity_type = ?")
        params.append(entity_type)
    if entity_name:
        clauses.append("LOWER(entity_name) LIKE ?")
        params.append(f"%{entity_name.lower()}%")
    if broker_phone:
        clauses.append("source_broker_phone = ?")
        params.append(broker_phone)
    where = " AND ".join(clauses) if clauses else "1=1"
    rows = storage.db.execute(
        f"""SELECT id, entity_type, entity_name, observation_type, observation_text,
                   confidence, observation_count, source_broker_name, source_broker_phone,
                   created_at, updated_at
            FROM knowledge_observations
            WHERE {where}
            ORDER BY confidence DESC, observation_count DESC, updated_at DESC
            LIMIT ?""",
        (*params, limit),
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/knowledge/observations/stats")
async def knowledge_observation_stats(user: dict = Depends(require_user)):
    if storage is None:
        return {}
    total = storage.db.execute("SELECT COUNT(*) FROM knowledge_observations").fetchone()[0]
    by_type = storage.db.execute(
        """SELECT observation_type, COUNT(*) as c
           FROM knowledge_observations GROUP BY observation_type ORDER BY c DESC"""
    ).fetchall()
    by_entity = storage.db.execute(
        """SELECT entity_type, COUNT(*) as c
           FROM knowledge_observations GROUP BY entity_type ORDER BY c DESC"""
    ).fetchall()
    top_entities = storage.db.execute(
        """SELECT entity_name, entity_type, COUNT(*) as c, MAX(confidence) as conf
           FROM knowledge_observations
           GROUP BY entity_name, entity_type
           ORDER BY c DESC LIMIT 20"""
    ).fetchall()
    return {
        "total": total,
        "by_type": [dict(r) for r in by_type],
        "by_entity_type": [dict(r) for r in by_entity],
        "top_entities": [dict(r) for r in top_entities],
    }


# ── Batch Observation Processing ────────────────────────────────────────────

@router.post("/api/knowledge/observations/batch")
async def create_observation_batch(req: BatchCreateRequest, user: dict = Depends(require_user)):
    if storage is None:
        return {"error": "storage not available"}
    from openai import OpenAI
    from lab.config import DOUBLEWORD_API_KEY
    rows, jsonl_path = _generate_batch_jsonl(req.max_messages)
    if not rows:
        return BatchCreateResponse(id=0, status="no_data", total_requests=0)
    client = OpenAI(api_key=DOUBLEWORD_API_KEY, base_url="https://api.doubleword.ai/v1")
    with open(jsonl_path, "rb") as f:
        file_obj = client.files.create(file=f, purpose="batch")
    batch = client.batches.create(
        input_file_id=file_obj.id,
        endpoint="/v1/chat/completions",
        completion_window="24h",
    )
    stats = {"total": len(rows), "sample": rows[:3]}
    cursor = storage.db.execute(
        """INSERT INTO observation_batches
           (batch_type, batch_api_id, status, total_requests, input_file_id, input_path, stats_snapshot, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        (req.batch_type, batch.id, batch.status or "pending", len(rows),
         file_obj.id, jsonl_path, json.dumps(stats),
         _iso_now(), _iso_now()),
    )
    batch_db_id = cursor.lastrowid
    return BatchCreateResponse(
        id=batch_db_id,
        batch_api_id=batch.id,
        status=batch.status or "pending",
        total_requests=len(rows),
        stats_snapshot=json.dumps(stats),
    )


@router.get("/api/knowledge/observations/batches")
async def list_observation_batches(user: dict = Depends(require_user)):
    if storage is None:
        return []
    rows = storage.db.execute(
        """SELECT id, batch_type, batch_api_id, status, total_requests,
                  completed_count, failed_count, input_file_id, output_file_id,
                  error_message, stats_snapshot, created_at, updated_at
           FROM observation_batches
           ORDER BY created_at DESC
           LIMIT 50"""
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/knowledge/observations/batches/{batch_id}")
async def get_observation_batch(batch_id: int, user: dict = Depends(require_user)):
    if storage is None:
        return {"error": "no storage"}
    row = storage.db.execute(
        """SELECT id, batch_type, batch_api_id, status, total_requests,
                  completed_count, failed_count, input_file_id, output_file_id,
                  error_message, stats_snapshot, created_at, updated_at
           FROM observation_batches WHERE id = ?""",
        (batch_id,),
    ).fetchone()
    if not row:
        return {"error": "not found"}
    return dict(row)


@router.post("/api/knowledge/observations/batches/{batch_id}/check")
async def check_batch_status(batch_id: int, user: dict = Depends(require_user)):
    if storage is None:
        return {"error": "no storage"}
    row = storage.db.execute(
        "SELECT * FROM observation_batches WHERE id = ?", (batch_id,)
    ).fetchone()
    if not row or not row["batch_api_id"]:
        return {"error": "no batch_api_id"}
    if row["status"] in ("completed", "failed", "cancelled"):
        return {"status": row["status"], "note": "already terminal"}
    from openai import OpenAI
    from lab.config import DOUBLEWORD_API_KEY
    client = OpenAI(api_key=DOUBLEWORD_API_KEY, base_url="https://api.doubleword.ai/v1")
    try:
        api_batch = client.batches.retrieve(row["batch_api_id"])
    except Exception as e:
        return {"error": str(e)}
    new_status = api_batch.status or row["status"]
    output_file_id = getattr(api_batch, "output_file_id", None)
    error_message = getattr(api_batch, "errors", None)
    if error_message and not isinstance(error_message, str):
        error_message = str(error_message)
    storage.db.execute(
        """UPDATE observation_batches
           SET status = ?, output_file_id = ?, error_message = ?,
               completed_count = ?, failed_count = ?,
               updated_at = ?
           WHERE id = ?""",
        (new_status, output_file_id, error_message,
         (api_batch.request_counts.completed if api_batch.request_counts else 0),
         (api_batch.request_counts.failed if api_batch.request_counts else 0),
         _iso_now(),
          batch_id),
    )
    return {
        "status": new_status,
        "output_file_id": output_file_id,
        "completed": api_batch.request_counts.completed if api_batch.request_counts else 0,
        "failed": api_batch.request_counts.failed if api_batch.request_counts else 0,
        "total": row["total_requests"],
    }


@router.post("/api/knowledge/observations/batches/{batch_id}/apply")
async def apply_batch_results(batch_id: int, user: dict = Depends(require_user)):
    if storage is None:
        return {"error": "no storage"}
    row = storage.db.execute(
        "SELECT * FROM observation_batches WHERE id = ?", (batch_id,)
    ).fetchone()
    if not row:
        return {"error": "not found"}
    if not row["output_file_id"]:
        return {"error": "no output file — batch may not be complete"}
    if row["status"] != "completed":
        return {"error": f"batch status is {row['status']}, not completed"}
    from openai import OpenAI
    from lab.config import DOUBLEWORD_API_KEY
    client = OpenAI(api_key=DOUBLEWORD_API_KEY, base_url="https://api.doubleword.ai/v1")
    try:
        content = client.files.content(row["output_file_id"]).text
    except Exception as e:
        return {"error": f"download failed: {e}"}
    lines = [l for l in content.strip().split("\n") if l.strip()]
    merged = 0
    errors = 0
    now = _iso_now()
    for line in lines:
        try:
            result = json.loads(line)
        except json.JSONDecodeError:
            errors += 1
            continue
        custom_id = result.get("custom_id", "")
        if not custom_id.startswith("obs_"):
            continue
        parsed_id = int(custom_id.split("_", 1)[1])
        body = result.get("response", {}).get("body", {})
        choice = (body.get("choices") or [None])[0]
        content_text = (choice or {}).get("message", {}).get("content", "")
        if not content_text:
            continue
        try:
            observations = json.loads(content_text)
        except json.JSONDecodeError:
            continue
        if not isinstance(observations, list):
            continue
        broker_row = storage.db.execute(
            "SELECT broker_name, broker_phone FROM parsed_output WHERE id = ?",
            (parsed_id,),
        ).fetchone()
        broker_name = (broker_row["broker_name"] or "") if broker_row else ""
        broker_phone = (broker_row["broker_phone"] or "") if broker_row else ""
        for obs in observations:
            if not obs.get("entity_type") or not obs.get("entity_name") or not obs.get("observation_text"):
                continue
            try:
                _merge_observation(
                    entity_type=obs["entity_type"],
                    entity_name=obs["entity_name"],
                    observation_type=obs.get("observation_type", "building_feedback"),
                    observation_text=obs["observation_text"],
                    broker_name=broker_name,
                    broker_phone=broker_phone,
                    parsed_id=parsed_id,
                    raw_id=None,
                    now=now,
                )
                merged += 1
            except Exception:
                errors += 1
    storage.db.execute(
        """UPDATE observation_batches
           SET status = 'applied', updated_at = ?
           WHERE id = ?""",
        (now, batch_id),
    )
    return {"merged": merged, "errors": errors, "total_lines": len(lines)}


# ── Block 4: Teach Observation ──────────────────────────────────────────────

@router.post("/api/observations/{obs_id}/teach")
async def teach_observation(obs_id: int, data: dict, user: dict = Depends(require_user)):
    result = storage.teach_observation(obs_id, data)
    return result


# ── Block 5: Knowledge Records API ──────────────────────────────────────────

@router.get("/api/knowledge/records")
async def get_knowledge_records(
    limit: int = 100,
    offset: int = 0,
    q: str | None = None,
    content_type: str | None = None,
    user: dict = Depends(require_user),
):
    return storage.get_knowledge_records(limit=limit, offset=offset, q=q, content_type=content_type)


@router.get("/api/knowledge/search")
async def search_knowledge(
    q: str,
    limit: int = 20,
    offset: int = 0,
    content_type: str | None = None,
    user: dict = Depends(require_user),
):
    return storage.search_knowledge_records(q, limit=limit, offset=offset, content_type=content_type)


@router.get("/api/knowledge/stats")
async def get_knowledge_stats(user: dict = Depends(require_user)):
    return storage.get_knowledge_stats()


@router.get("/api/knowledge/embeddings/stats")
async def get_embedding_stats(user: dict = Depends(require_user)):
    return storage.get_embedding_stats()


@router.post("/api/knowledge/embeddings/embed-all")
async def embed_all_records(user: dict = Depends(require_user)):
    from knowledge.embedder import get_embedder
    embedder = get_embedder(storage.db)
    count = embedder.embed_all_records()
    return {"status": "ok", "embedded": count}


@router.get("/api/knowledge/search/semantic")
async def semantic_search(q: str, limit: int = 10, user: dict = Depends(require_user)):
    return storage.search_knowledge_with_embeddings(q, limit=limit)


@router.post("/api/knowledge/classify")
async def classify_records(request: Request, user: dict = Depends(require_user)):
    from knowledge.classifier import classify_and_store
    body = await request.json() if request.headers.get("content-type") == "application/json" else {}
    limit = body.get("limit", 50)
    result = classify_and_store(storage.db, limit=limit)
    return {"status": "ok", **result}


@router.post("/api/knowledge/classify/single")
async def classify_single(request: Request, user: dict = Depends(require_user)):
    from knowledge.classifier import classify
    body = await request.json()
    message = body.get("message", "")
    if not message:
        raise HTTPException(400, "message required")
    return classify(message)


@router.get("/api/knowledge/intelligence")
async def get_intelligence_report(user: dict = Depends(require_user)):
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.generate_full_report()


@router.get("/api/knowledge/intelligence/digest")
async def get_daily_digest(days: int = 7, user: dict = Depends(require_user)):
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.get_daily_digest(days=days)


@router.get("/api/knowledge/intelligence/prices")
async def get_price_insights(user: dict = Depends(require_user)):
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.get_price_insights()


@router.get("/api/knowledge/intelligence/coverage")
async def get_market_coverage(user: dict = Depends(require_user)):
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.get_market_coverage()


@router.get("/api/knowledge/intelligence/brokers")
async def get_broker_insights(user: dict = Depends(require_user)):
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.get_broker_insights()


@router.get("/api/knowledge/intelligence/anomalies")
async def get_anomalies(user: dict = Depends(require_user)):
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.get_anomalies()


@router.get("/api/knowledge/intelligence/actionable")
async def get_actionable_insights(user: dict = Depends(require_user)):
    from knowledge.intelligence import get_engine
    engine = get_engine(storage.db)
    return engine.get_actionable_insights()


@router.get("/api/knowledge/aliases")
async def get_knowledge_aliases(entity_type: str | None = None, limit: int = 100, user: dict = Depends(require_user)):
    if entity_type:
        rows = storage.db.execute("""
            SELECT alias, canonical, entity_type, confidence, source, intel
            FROM knowledge_aliases
            WHERE entity_type = ?
            ORDER BY confidence DESC
            LIMIT ?
        """, (entity_type, limit)).fetchall()
    else:
        rows = storage.db.execute("""
            SELECT alias, canonical, entity_type, confidence, source, intel
            FROM knowledge_aliases
            ORDER BY confidence DESC
            LIMIT ?
        """, (limit,)).fetchall()
    result = []
    for r in rows:
        item = {"alias": r[0], "canonical": r[1], "entity_type": r[2], "confidence": r[3], "source": r[4]}
        item["intel"] = (json.loads(r[5]) if r[5] and r[5] != "{}" else None) if len(r) > 5 else None
        result.append(item)
    return result


@router.post("/api/knowledge/aliases")
async def add_knowledge_alias(request: Request, user: dict = Depends(require_user)):
    body = await request.json()
    alias = body.get("alias")
    canonical = body.get("canonical")
    entity_type = body.get("entity_type")
    if not alias or not canonical or not entity_type:
        raise HTTPException(400, "alias, canonical, and entity_type required")
    ok = storage.add_knowledge_alias(alias, canonical, entity_type, source="user")
    return {"status": "ok" if ok else "error"}


@router.get("/api/knowledge/learning-cards")
async def get_learning_cards(status: str = "pending", limit: int = 100, user: dict = Depends(require_user)):
    return storage.get_learning_cards(status=status, limit=limit)


@router.post("/api/knowledge/learning-cards/{card_id}/resolve")
async def resolve_learning_card(card_id: int, request: Request, user: dict = Depends(require_user)):
    body = await request.json()
    resolved_type = body.get("resolved_type")
    resolved_value = body.get("resolved_value")
    if not resolved_type or not resolved_value:
        raise HTTPException(400, "resolved_type and resolved_value required")
    ok = storage.resolve_learning_card(card_id, resolved_type, resolved_value, "user")
    return {"status": "ok" if ok else "error"}


@router.get("/api/knowledge/alias-intel/{alias}")
async def get_entity_intel(alias: str, user: dict = Depends(require_user)):
    intel = storage.get_entity_intel(alias)
    if intel is None:
        raise HTTPException(404, "Alias not found or no intel available")
    row = storage.db.execute(
        "SELECT alias, canonical, entity_type, source, created_at FROM knowledge_aliases WHERE alias = ?",
        (alias.lower(),),
    ).fetchone()
    return {
        "alias": row[0] if row else alias,
        "canonical": row[1] if row else alias,
        "entity_type": row[2] if row else "unknown",
        "source": row[3] if row else "",
        "created_at": row[4] if row else "",
        "intel": intel,
    }


@router.get("/api/knowledge/{record_id}")
async def get_knowledge_record(record_id: int, user: dict = Depends(require_user)):
    record = storage.get_knowledge_record(record_id)
    if not record:
        raise HTTPException(404, "Record not found")
    return record


@router.patch("/api/knowledge/{record_id}")
async def update_knowledge_record(record_id: int, request: Request, user: dict = Depends(require_user)):
    body = await request.json()
    ok = storage.update_knowledge_record(record_id, body)
    return {"status": "ok" if ok else "error"}
