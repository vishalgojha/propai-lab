"""Groups, market data, and WhatsApp conversations routes."""
import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException, Request

from config import load_excluded_groups, save_excluded_groups
from routers.common import (
    storage,
    require_user,
    get_tenant_context,
    _resolve_active_organization_id,
    parse_group_name,
)

router = APIRouter(tags=["groups"])


@router.get("/api/price-stats")
async def price_stats_endpoint(market: str = "", bhk: str = "", intent: str = "listing", user: dict = Depends(require_user)):
    if market and bhk:
        result = storage.get_price_stats(market, bhk, intent)
        return result or {"error": "not found"}
    rows = storage.db.execute(
        "SELECT * FROM price_stats ORDER BY count DESC LIMIT 100"
    ).fetchall()
    return [dict(r) for r in rows]


@router.get("/api/enrichment-jobs/counts")
async def enrichment_counts(user: dict = Depends(require_user)):
    counts = {}
    for status in ("pending", "running", "completed", "failed"):
        r = storage.db.execute(
            "SELECT COUNT(*) FROM enrichment_jobs WHERE status = ?", (status,)
        ).fetchone()
        counts[status] = r[0]
    return counts


@router.post("/api/aliases/scan")
async def scan_aliases(user: dict = Depends(require_user)):
    from agents.alias_learner import check_for_aliases
    check_for_aliases(storage)
    return {"status": "ok"}


@router.post("/api/price-stats/recompute")
async def recompute_price_stats(user: dict = Depends(require_user)):
    storage.recompute_price_stats()
    return {"status": "ok"}


@router.get("/api/groups")
async def list_groups(user: dict = Depends(require_user)):
    jobs = storage.get_sync_jobs(limit=500, source="whatsapp")
    group_markets = storage.get_group_markets()
    opt_out_list = load_excluded_groups()
    groups = []
    for j in jobs:
        try:
            meta = json.loads(j.meta) if isinstance(j.meta, str) else (j.meta or {})
        except (json.JSONDecodeError, TypeError):
            meta = {}
        participants = j.participants or meta.get("participants", 0) or 0
        parsed = parse_group_name(j.group_name)
        derived = group_markets.get(j.group_name) or []
        merged_markets = list(dict.fromkeys([*parsed.get("markets", []), *derived]))
        enriched = {**parsed, "markets": merged_markets}
        excluded = any(
            entry.lower() in j.group_name.lower() or entry.lower() == str(j.group_id).lower()
            for entry in opt_out_list
        ) if opt_out_list else False
        groups.append({
            "jid": j.group_id,
            "name": j.group_name,
            "participants": participants,
            "parsed": enriched,
            "records_found": j.records_found or 0,
            "records_processed": j.records_processed or 0,
            "status": j.status,
            "error": j.error,
            "allowed": not excluded,
            "excluded": excluded,
        })
    return sorted(groups, key=lambda g: g["name"].lower())


@router.get("/api/groups/{jid}/members")
async def list_group_members(jid: str, user: dict = Depends(require_user)):
    tenant_id = await asyncio.to_thread(
        _resolve_active_organization_id, user, None,
    )
    if not tenant_id:
        return []

    def _fetch():
        rows = (
            storage.client.table("group_members")
            .select("display_name,member_phone,member_jid,is_admin,last_seen_at")
            .eq("tenant_id", tenant_id)
            .eq("group_id", jid)
            .order("display_name", desc=False)
            .limit(500)
            .execute()
            .data
        )
        seen = set()
        members = []
        for r in rows:
            key = r.get("member_jid") or r.get("member_phone") or ""
            if key in seen:
                continue
            seen.add(key)
            name = (r.get("display_name") or "").strip()
            phone = (r.get("member_phone") or "").strip()
            if not name and phone:
                name = phone
            elif not name:
                name = "Unknown"
            members.append({
                "name": name,
                "phone": phone,
                "is_admin": bool(r.get("is_admin")),
                "last_seen": r.get("last_seen_at"),
            })
        return members

    return await asyncio.to_thread(_fetch)


@router.get("/api/whatsapp/conversations")
async def list_whatsapp_conversations(
    types: str = "group,broadcast",
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    allowed = {"group", "broadcast", "direct"}
    requested = [value.strip() for value in types.split(",") if value.strip() in allowed]
    active_org_id = await asyncio.to_thread(
        _resolve_active_organization_id, user, tenant_id,
    )
    return await asyncio.to_thread(
        storage.get_whatsapp_conversations,
        active_org_id,
        requested or ["group", "broadcast"],
        1000,
    )


@router.get("/api/groups/opt-out")
async def get_opt_out_list(user: dict = Depends(require_user)):
    return load_excluded_groups()


@router.post("/api/groups/opt-out")
async def set_opt_out_list(request: Request, user: dict = Depends(require_user)):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    if not isinstance(body, list):
        raise HTTPException(400, "Expected a JSON array of strings")
    entries = [str(x).strip() for x in body if x and str(x).strip()]
    save_excluded_groups(entries)
    return {"status": "ok", "count": len(entries)}


@router.delete("/api/groups/opt-out")
async def clear_opt_out_list(user: dict = Depends(require_user)):
    save_excluded_groups([])
    return {"status": "ok"}


@router.get("/api/groups/allowlist")
async def get_allowlist(user: dict = Depends(require_user)):
    return load_excluded_groups()


@router.post("/api/groups/allowlist")
async def set_allowlist(request: Request, user: dict = Depends(require_user)):
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(400, "Invalid JSON")
    if not isinstance(body, list):
        raise HTTPException(400, "Expected a JSON array of strings")
    entries = [str(x).strip() for x in body if x and str(x).strip()]
    save_excluded_groups(entries)
    return {"status": "ok", "count": len(entries)}


@router.delete("/api/groups/allowlist")
async def clear_allowlist(user: dict = Depends(require_user)):
    save_excluded_groups([])
    return {"status": "ok"}
