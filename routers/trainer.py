"""
Trainer routes — knowledge trainer: terms, stats, discover, resolve, scan, candidates, combined localities.
"""
import json

from fastapi import APIRouter, Depends, HTTPException, Request

from routers.common import storage, require_user

router = APIRouter(tags=["trainer"])


@router.get("/api/trainer/terms")
async def get_trainer_terms(status: str | None = None, limit: int = 100, user: dict = Depends(require_user)):
    return storage.get_trainer_terms(status=status, limit=limit)


@router.get("/api/trainer/stats")
async def get_trainer_stats(user: dict = Depends(require_user)):
    return storage.get_trainer_stats()


@router.get("/api/trainer/discover")
async def discover_unknown_terms(limit: int = 50, user: dict = Depends(require_user)):
    return storage.find_unknown_terms(limit=limit)


@router.post("/api/trainer/resolve")
async def resolve_trainer_term(request: Request, user: dict = Depends(require_user)):
    body = await request.json()
    term_id = body.get("term_id")
    status = body.get("status")
    if not term_id or not status:
        raise HTTPException(400, "term_id and status required")
    if status not in ("building", "society", "landmark", "locality", "combined_locality", "other", "ignored"):
        raise HTTPException(400, "Invalid status")
    notes = body.get("notes", "")
    expands_to = body.get("expands_to")
    ok = storage.resolve_trainer_term(term_id, status, "user", notes, expands_to=expands_to)
    return {"status": "ok" if ok else "error"}


@router.post("/api/trainer/batch")
async def batch_trainer(request: Request, user: dict = Depends(require_user)):
    body = await request.json()
    items = body.get("items", [])
    for item in items:
        term_id = item.get("term_id")
        st = item.get("status")
        notes = item.get("notes", "")
        if term_id and st:
            storage.resolve_trainer_term(term_id, st, "user", notes)
    return {"status": "ok", "count": len(items)}


@router.post("/api/trainer/scan")
async def scan_for_unknown(user: dict = Depends(require_user)):
    unknowns = storage.find_unknown_terms(limit=100)
    added = 0
    blacklisted = 0
    candidates = 0
    for u in unknowns:
        if not u.get("already_in_trainer"):
            context = u.get("contexts", [""])[0] if u.get("contexts") else ""
            raw_ids = u.get("raw_ids", [])
            result = storage.add_trainer_term(
                u["term"],
                context=context,
                raw_message_id=raw_ids[0] if raw_ids else None,
            )
            if isinstance(result, dict):
                if result.get("status") == "candidate":
                    candidates += 1
                elif result.get("error") == "blacklisted":
                    blacklisted += 1
                elif "term" in result:
                    added += 1
            else:
                added += 1
    return {"status": "ok", "discovered": len(unknowns), "added": added, "blacklisted": blacklisted, "candidates": candidates}


@router.get("/api/trainer/candidates")
async def list_learning_candidates(limit: int = 100, status: str = "candidate", user: dict = Depends(require_user)):
    try:
        where = "WHERE status = ?" if status else ""
        params = [status] if status else []
        rows = storage.db.execute(f"""
            SELECT id, phrase, frequency, confidence,
                   first_seen, last_seen, contexts, raw_message_ids, source, status
            FROM knowledge_learning_candidates
            {where}
            ORDER BY frequency DESC, confidence DESC
            LIMIT ?
        """, (*params, limit)).fetchall()
        return [
            {
                "id": r[0], "phrase": r[1], "frequency": r[2],
                "confidence": r[3], "first_seen": r[4], "last_seen": r[5],
                "contexts": json.loads(r[6]) if r[6] else [],
                "raw_message_ids": json.loads(r[7]) if r[7] else [],
                "source": r[8], "status": r[9],
            }
            for r in rows
        ]
    except Exception as e:
        return {"error": str(e)}


@router.post("/api/trainer/candidates/{candidate_id}/promote")
async def promote_learning_candidate(candidate_id: int, user: dict = Depends(require_user)):
    try:
        row = storage.db.execute(
            "SELECT phrase, contexts, raw_message_ids FROM knowledge_learning_candidates WHERE id = ?",
            (candidate_id,)
        ).fetchone()
        if not row:
            raise HTTPException(404, "Candidate not found")
        phrase, contexts_json, raw_ids_json = row
        contexts = json.loads(contexts_json) if contexts_json else []
        raw_ids = json.loads(raw_ids_json) if raw_ids_json else []
        result = storage.add_trainer_term(
            phrase,
            context=(contexts or [""])[0],
            raw_message_id=(raw_ids or [None])[0],
        )
        if isinstance(result, dict) and "error" in result:
            return {"status": "error", "error": result["error"]}
        storage.db.execute(
            "UPDATE knowledge_learning_candidates SET status = 'promoted' WHERE id = ?",
            (candidate_id,)
        )
        storage.db.commit()
        return {"status": "promoted", "phrase": phrase}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(500, str(e))


@router.post("/api/trainer/inline-resolve")
async def inline_trainer_resolve(request: Request, user: dict = Depends(require_user)):
    body = await request.json()
    text = body.get("text", "").strip()
    raw_message_id = body.get("raw_message_id")
    status = body.get("status")
    notes = body.get("notes", "")
    if not text or not status:
        raise HTTPException(400, "text and status required")
    if status not in ("building", "society", "landmark", "locality", "combined_locality", "other", "ignored"):
        raise HTTPException(400, "Invalid status")
    existing = storage.db.execute(
        "SELECT id FROM knowledge_trainer WHERE term = ?", (text,)
    ).fetchone()
    if existing:
        term_id = existing[0]
    else:
        context = ""
        if raw_message_id:
            msg_row = storage.db.execute(
                "SELECT message FROM raw_messages WHERE id = ?", (raw_message_id,)
            ).fetchone()
            if msg_row:
                context = (msg_row[0] or "")[:120]
        result = storage.add_trainer_term(text, context=context, raw_message_id=raw_message_id, force_trainer=True)
        if "error" in result:
            raise HTTPException(500, result["error"])
        term_id = storage.db.execute(
            "SELECT id FROM knowledge_trainer WHERE term = ?", (text,)
        ).fetchone()[0]
    expands_to = body.get("expands_to")
    ok = storage.resolve_trainer_term(term_id, status, "user", notes, expands_to=expands_to)
    return {"status": "ok" if ok else "error", "term": text}


@router.get("/api/trainer/combined-localities")
async def list_combined_localities(user: dict = Depends(require_user)):
    rows = storage.db.execute("""
        SELECT id, surface, expands_to, created_at
        FROM combined_locality_rules
        ORDER BY created_at DESC
    """).fetchall()
    return [
        {
            "id": r[0], "surface": r[1],
            "expands_to": json.loads(r[2]) if r[2] else [],
            "created_at": r[3],
        }
        for r in rows
    ]


@router.get("/api/trainer/localities")
async def get_trainer_localities(user: dict = Depends(require_user)):
    rows = storage.db.execute("""
        SELECT canonical, COUNT(*) as cnt
        FROM knowledge_aliases
        WHERE entity_type = 'market'
        GROUP BY canonical
        ORDER BY cnt DESC
    """).fetchall()
    return {
        "localities": [
            {"name": r[0], "count": r[1]}
            for r in rows
        ]
    }
