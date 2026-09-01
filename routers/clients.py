"""Client requirements and candidate matching routes."""
import asyncio
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import JSONResponse

from routers.common import storage, require_user

router = APIRouter(tags=["clients"])


def _get_client_store():
    if storage is None:
        raise RuntimeError("Storage is not initialized")
    return storage


# ── Requirement-Listing Matching ──────────────────────────────────


@router.post("/api/requirements/match")
async def match_requirements(user: dict = Depends(require_user)):
    """Run the matcher to compute requirement-listing matches."""
    total = storage.match_requirements()
    return {"matched": total}


@router.get("/api/requirements/matches/summary")
async def requirement_matches_summary(user: dict = Depends(require_user)):
    """Get match counts for all requirements (for table display)."""
    summary = storage.get_match_summary()
    return {str(m["requirement_id"]): {"count": m["match_count"], "best": m["best_score"]} for m in summary}


@router.get("/api/requirements/{req_id}/matches")
async def requirement_matches(req_id: int, limit: int = 20, user: dict = Depends(require_user)):
    """Get matching listings for a specific requirement."""
    matches = storage.get_requirement_matches(req_id, limit=limit)
    return {"requirement_id": req_id, "matches": matches, "count": len(matches)}


# ── Client CRUD ──────────────────────────────────────────────────


@router.get("/api/clients")
async def list_clients(q: str = "", limit: int = 20, user: dict = Depends(require_user)):
    return _get_client_store().get_clients(q)[:limit]


@router.post("/api/clients")
async def create_client(body: dict, user: dict = Depends(require_user)):
    name = body.get("name", "").strip()
    if not name:
        return JSONResponse(status_code=400, content={"error": "name_required"})
    cid = _get_client_store().create_client(name, body.get("phone"), body.get("email"), body.get("notes", ""))
    return {"id": cid, "name": name}


@router.get("/api/clients/{client_id}")
async def get_client(client_id: int, user: dict = Depends(require_user)):
    c = _get_client_store().get_client(client_id)
    if not c:
        return JSONResponse(status_code=404, content={"error": "not_found"})
    c["requirements"] = _get_client_store().get_client_requirements(client_id)
    c["candidates"] = _get_client_store().get_client_candidates(client_id)
    return c


@router.put("/api/clients/{client_id}")
async def update_client(client_id: int, body: dict, user: dict = Depends(require_user)):
    _get_client_store().update_client(client_id, **body)
    return {"ok": True}


# ── Client Aliases ───────────────────────────────────────────────


@router.post("/api/clients/{client_id}/aliases")
async def add_client_alias(client_id: int, body: dict, user: dict = Depends(require_user)):
    alias = str(body.get("alias") or "").strip()
    if not alias:
        return JSONResponse(status_code=400, content={"error": "alias_required"})
    alias_id = _get_client_store().add_client_alias(
        client_id,
        alias,
        source=body.get("source", "manual"),
        confidence=float(body.get("confidence", 1.0)),
    )
    if alias_id is None:
        return JSONResponse(status_code=409, content={"error": "alias_exists_for_another_client"})
    return {"id": alias_id}


# ── Client Notes ─────────────────────────────────────────────────


@router.get("/api/clients/{client_id}/notes")
async def list_client_notes(client_id: int, active_only: bool = True, limit: int = 100, user: dict = Depends(require_user)):
    return _get_client_store().get_client_notes(client_id, active_only=active_only, limit=max(1, min(limit, 500)))


@router.post("/api/clients/{client_id}/notes")
async def add_client_note(client_id: int, body: dict, user: dict = Depends(require_user)):
    note = str(body.get("body") or "").strip()
    if not note:
        return JSONResponse(status_code=400, content={"error": "body_required"})
    note_id = _get_client_store().add_client_note(
        client_id,
        note,
        note_type=body.get("note_type", "note"),
        source_text=body.get("source_text", ""),
        source_jid=body.get("source_jid", ""),
        source_message_id=body.get("source_message_id", ""),
        confidence=float(body.get("confidence", 1.0)),
        supersedes_note_id=body.get("supersedes_note_id"),
    )
    return {"id": note_id}


@router.put("/api/clients/notes/{note_id}")
async def update_client_note(note_id: int, body: dict, user: dict = Depends(require_user)):
    note = str(body.get("body") or "").strip()
    if not note:
        return JSONResponse(status_code=400, content={"error": "body_required"})
    _get_client_store().update_client_note(
        note_id,
        note,
        note_type=body.get("note_type"),
        is_active=body.get("is_active"),
    )
    return {"ok": True}


# ── Client Requirements ──────────────────────────────────────────


@router.post("/api/clients/{client_id}/requirements")
async def add_requirement(client_id: int, body: dict, user: dict = Depends(require_user)):
    intent = body.get("intent", "BUY").upper()
    rid = _get_client_store().add_client_requirement(
        client_id, intent,
        bhk=body.get("bhk"),
        price_min=body.get("price_min"),
        price_max=body.get("price_max"),
        micro_market=body.get("micro_market"),
        building_name=body.get("building_name"),
        area_sqft_min=body.get("area_sqft_min"),
        area_sqft_max=body.get("area_sqft_max"),
        furnishing=body.get("furnishing"),
        use_type=body.get("use_type"),
        notes=body.get("notes", ""),
    )
    return {"id": rid}


# ── Client Candidates ────────────────────────────────────────────


@router.get("/api/clients/{client_id}/candidates")
async def list_candidates(client_id: int, status: str = None, user: dict = Depends(require_user)):
    rows = _get_client_store().get_client_candidates(client_id, status)
    for row in rows:
        row["availability"] = _get_client_store().estimate_candidate_availability(row)
    return rows


@router.post("/api/clients/{client_id}/candidates")
async def add_candidate(client_id: int, body: dict, user: dict = Depends(require_user)):
    cid = _get_client_store().add_property_candidate(
        client_id,
        source_schema=body.get("source_schema"),
        source_id=body.get("source_id"),
        listing_id=body.get("listing_id"),
        message_id=body.get("message_id"),
        building_name=body.get("building_name"),
        micro_market=body.get("micro_market"),
        bhk=body.get("bhk"),
        price=body.get("price"),
        price_unit=body.get("price_unit"),
        area_sqft=body.get("area_sqft"),
        furnishing=body.get("furnishing"),
        confidence=body.get("confidence", 0),
        match_breakdown=body.get("match_breakdown"),
        source_text=body.get("source_text", ""),
        notes=body.get("notes", ""),
        source_timestamp=body.get("source_timestamp"),
        availability_status=body.get("availability_status", "unknown"),
    )
    if cid is None:
        return JSONResponse(status_code=409, content={"error": "already_added"})
    return {"id": cid}


@router.post("/api/clients/{client_id}/candidates/bulk")
async def add_candidates_bulk(client_id: int, body: dict, user: dict = Depends(require_user)):
    refs = body.get("candidates") or []
    if not isinstance(refs, list) or not refs or len(refs) > 100:
        return JSONResponse(status_code=400, content={"error": "candidates_required"})
    added = 0
    already_added = 0
    for ref in refs:
        try:
            candidate_id = _get_client_store().add_property_candidate(
                client_id,
                source_schema=ref.get("source_schema"),
                source_id=ref.get("source_id"),
            )
        except ValueError as exc:
            return JSONResponse(status_code=400, content={"error": str(exc)})
        if candidate_id is None:
            already_added += 1
        else:
            added += 1
    return {"added": added, "already_added": already_added}


@router.put("/api/clients/candidates/{candidate_id}/status")
async def update_candidate_status(candidate_id: int, body: dict, user: dict = Depends(require_user)):
    status = body.get("status", "viewed")
    _get_client_store().update_candidate_status(candidate_id, status)
    return {"ok": True}


@router.put("/api/clients/candidates/{candidate_id}/availability")
async def update_candidate_availability(candidate_id: int, body: dict, user: dict = Depends(require_user)):
    status = body.get("availability_status", "unknown")
    _get_client_store().update_candidate_availability(candidate_id, status, body.get("availability_checked_at"))
    return {"ok": True}


# ── Match Clients ────────────────────────────────────────────────


@router.post("/api/clients/match")
async def match_clients_to_listing(body: dict, user: dict = Depends(require_user)):
    """Match a listing against all active client requirements."""
    price = body.get("price", 0)
    bhk = body.get("bhk", "")
    micro_market = body.get("micro_market", "")
    area_sqft = body.get("area_sqft", 0)
    building_name = body.get("building_name", "")
    furnishing = body.get("furnishing", "")
    intent = body.get("intent", "")

    requirements = _get_client_store().get_all_active_requirements()
    matches = []

    for req in requirements:
        score = 0
        breakdown = {}

        req_intent = (req.get("intent") or "").upper()
        if intent and req_intent and intent.upper() != req_intent:
            continue

        if bhk and req.get("bhk"):
            req_bhk = req["bhk"].replace(" BHK", "").strip()
            msg_bhk = bhk.replace(" BHK", "").strip()
            if req_bhk == msg_bhk:
                score += 30
                breakdown["bhk"] = {"match": True, "score": 30}
            elif abs(int(req_bhk or 0) - int(msg_bhk or 0)) <= 1:
                score += 15
                breakdown["bhk"] = {"match": "close", "score": 15}
            else:
                breakdown["bhk"] = {"match": False, "score": 0}
        else:
            score += 15
            breakdown["bhk"] = {"match": "unknown", "score": 15}

        if price and req.get("price_min") is not None and req.get("price_max") is not None:
            if req["price_min"] <= price <= req["price_max"]:
                score += 25
                breakdown["price"] = {"match": True, "score": 25}
            elif price < req["price_min"]:
                ratio = price / req["price_min"] if req["price_min"] else 0
                if ratio >= 0.8:
                    score += 12
                    breakdown["price"] = {"match": "close_low", "score": 12}
                else:
                    breakdown["price"] = {"match": False, "score": 0}
            else:
                ratio = req["price_max"] / price if price else 0
                if ratio >= 0.8:
                    score += 12
                    breakdown["price"] = {"match": "close_high", "score": 12}
                else:
                    breakdown["price"] = {"match": False, "score": 0}
        else:
            score += 12
            breakdown["price"] = {"match": "unknown", "score": 12}

        if micro_market and req.get("micro_market"):
            if micro_market.lower() == req["micro_market"].lower():
                score += 25
                breakdown["location"] = {"match": True, "score": 25}
            elif micro_market.lower() in (req["micro_market"] or "").lower() or (req["micro_market"] or "").lower() in micro_market.lower():
                score += 15
                breakdown["location"] = {"match": "partial", "score": 15}
            else:
                breakdown["location"] = {"match": False, "score": 0}
        else:
            score += 12
            breakdown["location"] = {"match": "unknown", "score": 12}

        if area_sqft and (req.get("area_sqft_min") is not None or req.get("area_sqft_max") is not None):
            amin = req.get("area_sqft_min") or 0
            amax = req.get("area_sqft_max") or 99999
            if amin <= area_sqft <= amax:
                score += 10
                breakdown["area"] = {"match": True, "score": 10}
            else:
                breakdown["area"] = {"match": False, "score": 0}
        else:
            score += 5
            breakdown["area"] = {"match": "unknown", "score": 5}

        if building_name and req.get("building_name"):
            if building_name.lower() == req["building_name"].lower():
                score += 10
                breakdown["building"] = {"match": True, "score": 10}
            else:
                breakdown["building"] = {"match": False, "score": 0}
        else:
            score += 5
            breakdown["building"] = {"match": "unknown", "score": 5}

        matches.append({
            "requirement": req,
            "score": min(score, 100),
            "breakdown": breakdown,
        })

    matches.sort(key=lambda x: x["score"], reverse=True)
    return {"matches": matches[:10]}


# ── Client Messages ──────────────────────────────────────────────


@router.get("/api/clients/{client_id}/messages")
async def get_client_messages(client_id: int, limit: int = 100, offset: int = 0, user: dict = Depends(require_user)):
    return storage.get_client_messages(client_id, limit, offset)
