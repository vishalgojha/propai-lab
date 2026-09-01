"""Buildings + building aliases + IGR routes."""
from fastapi import APIRouter, Depends, HTTPException

from routers.common import storage, require_user

router = APIRouter(tags=["buildings"])


@router.get("/api/buildings")
async def list_buildings(limit: int = 100, offset: int = 0, status: str = "", user: dict = Depends(require_user)):
    where = ""
    params = []
    if status:
        where = "WHERE b.status = ?"
        params.append(status)

    rows = storage.db.execute(f"""
        SELECT b.id, b.building_id, b.canonical_name, b.micro_market, b.developer,
               b.address, b.pincode, b.latitude, b.longitude,
               b.google_place_id, b.plus_code, b.geocode_source, b.geocode_confidence, b.geocoded_at,
               b.observed_listings, b.observed_brokers, b.observed_requirements,
               b.last_enriched, b.enrichment_confidence, b.status,
               b.created_at, b.updated_at,
               (SELECT COUNT(*) FROM building_name_aliases WHERE building_id = b.id) as alias_count
        FROM buildings b
        {where}
        ORDER BY b.observed_listings DESC, b.canonical_name ASC
        LIMIT ? OFFSET ?
    """, params + [limit, offset]).fetchall()

    total = storage.db.execute(f"SELECT COUNT(*) FROM buildings b {where}", params).fetchone()[0]
    return {"buildings": [dict(r) for r in rows], "total": total, "limit": limit, "offset": offset}


@router.get("/api/buildings/suggestions")
async def building_suggestions(
    q: str = "",
    limit: int = 20,
    user: dict = Depends(require_user),
):
    """Search canonical building names from the Supabase building registry."""
    rows = storage.get_buildings(search=q.strip(), limit=max(1, min(limit, 50)))
    return {
        "suggestions": [
            {
                "label": row.get("canonical_name"),
                "locality": row.get("micro_market"),
                "canonical": True,
            }
            for row in rows
            if str(row.get("canonical_name") or "").strip()
        ]
    }


@router.post("/api/buildings/{building_id:path}/geocode")
async def geocode_building(building_id: str, user: dict = Depends(require_user)):
    """Resolve and cache a building's address/coordinates once."""
    if building_id.startswith("BLD-"):
        building = storage.get_building(building_id=building_id)
    else:
        building = storage.get_building(canonical_name=building_id)
    if not building:
        raise HTTPException(404, f"Building '{building_id}' not found")

    from agents.building_enrichment.providers import GooglePlacesProvider
    provider = GooglePlacesProvider()
    result = provider.enrich(
        building_name=building["canonical_name"],
        canonical_name=building["canonical_name"],
        micro_market=building.get("micro_market"),
    )
    if result.error or not result.fields:
        raise HTTPException(502, result.error or "No geocoding result")
    updated = storage.update_building_from_enrichment(
        building["id"], result.fields, result.provider, result.confidence
    )
    return {"building": updated, "provider": result.provider, "cached": result.cached}


@router.get("/api/buildings/{building_id}")
async def get_building_profile(building_id: str, user: dict = Depends(require_user)):
    if building_id.startswith("BLD-"):
        building = storage.get_building(building_id=building_id)
    else:
        building = storage.get_building(canonical_name=building_id)

    if not building:
        raise HTTPException(404, f"Building '{building_id}' not found")

    profile = storage.get_building_profile(building["id"])
    if not profile:
        raise HTTPException(404, f"Building profile not found")

    return profile


@router.post("/api/buildings/{building_id}/refresh")
async def refresh_building(building_id: str, provider: str = "", user: dict = Depends(require_user)):
    if building_id.startswith("BLD-"):
        building = storage.get_building(building_id=building_id)
    else:
        building = storage.get_building(canonical_name=building_id)

    if not building:
        raise HTTPException(404, f"Building '{building_id}' not found")

    if provider:
        storage.create_building_enrichment_job(building["id"], provider, priority=10)
    else:
        from agents.building_enrichment.providers import get_all_providers
        for p in get_all_providers():
            storage.create_building_enrichment_job(building["id"], p.name, priority=10)

    return {"status": "ok", "message": f"Enrichment jobs created for {building['canonical_name']}"}


@router.get("/api/buildings/{building_id}/aliases")
async def get_building_aliases(building_id: str, user: dict = Depends(require_user)):
    if building_id.startswith("BLD-"):
        building = storage.get_building(building_id=building_id)
    else:
        building = storage.get_building(canonical_name=building_id)

    if not building:
        raise HTTPException(404, f"Building '{building_id}' not found")

    aliases = storage.get_building_aliases(building["id"])
    return aliases


@router.post("/api/buildings/discover")
async def discover_buildings(user: dict = Depends(require_user)):
    from agents.building_enrichment.discovery import BuildingDiscovery
    discovery = BuildingDiscovery(storage)
    discovered = discovery.discover_from_observations(min_observations=2)
    return {
        "discovered": len(discovered),
        "new": len([d for d in discovered if not d.get("already_existed")]),
        "existing": len([d for d in discovered if d.get("already_existed")]),
        "buildings": discovered[:20],
    }


@router.post("/api/buildings/refresh-counts")
async def refresh_building_counts(user: dict = Depends(require_user)):
    storage.refresh_building_counts()
    total = storage.db.execute("SELECT COUNT(*) FROM buildings").fetchone()[0]
    with_listings = storage.db.execute("SELECT COUNT(*) FROM buildings WHERE observed_listings > 0").fetchone()[0]
    return {"status": "ok", "total_buildings": total, "with_listings": with_listings}


@router.get("/api/buildings/enrichment/dashboard")
async def building_enrichment_dashboard(user: dict = Depends(require_user)):
    stats = storage.get_building_enrichment_stats()
    return stats


@router.get("/api/buildings/enrichment/jobs")
async def building_enrichment_jobs(status: str = "", limit: int = 50, user: dict = Depends(require_user)):
    if status:
        rows = storage.db.execute("""
            SELECT j.*, b.building_id as building_code, b.canonical_name
            FROM building_enrichment_jobs j
            JOIN buildings b ON b.id = j.building_id
            WHERE j.status = ?
            ORDER BY j.created_at DESC
            LIMIT ?
        """, (status, limit)).fetchall()
    else:
        rows = storage.db.execute("""
            SELECT j.*, b.building_id as building_code, b.canonical_name
            FROM building_enrichment_jobs j
            JOIN buildings b ON b.id = j.building_id
            ORDER BY j.created_at DESC
            LIMIT ?
        """, (limit,)).fetchall()

    return [dict(r) for r in rows]


@router.get("/api/buildings/enrichment/history")
async def building_enrichment_history(building_id: str = "", limit: int = 50, user: dict = Depends(require_user)):
    if building_id:
        if building_id.startswith("BLD-"):
            building = storage.get_building(building_id=building_id)
        else:
            building = storage.get_building(canonical_name=building_id)

        if not building:
            raise HTTPException(404, f"Building '{building_id}' not found")

        rows = storage.db.execute("""
            SELECT * FROM building_enrichment_history
            WHERE building_id = ?
            ORDER BY created_at DESC
            LIMIT ?
        """, (building["id"], limit)).fetchall()
    else:
        rows = storage.db.execute("""
            SELECT h.*, b.canonical_name, b.building_id as building_code
            FROM building_enrichment_history h
            JOIN buildings b ON b.id = h.building_id
            ORDER BY h.created_at DESC
            LIMIT ?
        """, (limit,)).fetchall()

    return [dict(r) for r in rows]


# ── Building Alias Engine ────────────────────────────────────────


@router.post("/api/buildings/aliases/discover")
async def discover_building_aliases(min_confidence: float = 0.7, user: dict = Depends(require_user)):
    suggestions = storage.discover_alias_candidates(min_confidence=min_confidence)
    saved = storage.save_alias_suggestions(suggestions)
    return {"discovered": len(suggestions), "saved": saved, "suggestions": suggestions[:20]}


@router.get("/api/buildings/aliases/suggestions")
async def get_alias_suggestions(status: str = "pending", limit: int = 50, user: dict = Depends(require_user)):
    suggestions = storage.get_alias_suggestions(status=status, limit=limit)
    return {"suggestions": suggestions, "count": len(suggestions)}


@router.post("/api/buildings/aliases/{suggestion_id}/review")
async def review_alias_suggestion(suggestion_id: int, approved: bool, user: dict = Depends(require_user)):
    success = storage.review_alias_suggestion(suggestion_id, approved)
    if not success:
        return {"error": "Suggestion not found"}, 404
    return {"success": True, "approved": approved}


@router.get("/api/buildings/aliases/stats")
async def alias_stats(user: dict = Depends(require_user)):
    return storage.get_alias_stats()


@router.post("/api/buildings/aliases/normalize")
async def normalize_building_name(name: str, user: dict = Depends(require_user)):
    normalized = storage.normalize_building_name(name)
    return {"original": name, "normalized": normalized, "changed": name != normalized}
