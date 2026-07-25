"""Notes CRUD routes."""
import json

from fastapi import APIRouter, Depends, HTTPException

from routers.common import storage, get_current_member

router = APIRouter(tags=["notes"])

_VALID_NOTE_ENTITY_TYPES = frozenset({"chat", "broker", "building"})


@router.get("/api/notes")
async def list_notes(
    entity_type: str,
    entity_id: str,
    member: dict = Depends(get_current_member),
):
    if entity_type not in _VALID_NOTE_ENTITY_TYPES:
        raise HTTPException(400, f"Invalid entity_type. Must be one of: {', '.join(sorted(_VALID_NOTE_ENTITY_TYPES))}")
    if not entity_id:
        raise HTTPException(400, "entity_id is required")
    rows = storage.db.execute(
        """SELECT n.id, n.entity_type, n.entity_id, n.body, n.mentioned_member_ids,
                  n.created_at, n.updated_at, n.author_id,
                  tm.name AS author_name
           FROM internal_notes n
           LEFT JOIN team_members tm ON tm.id = n.author_id
           WHERE n.entity_type = ? AND n.entity_id = ?
           ORDER BY n.created_at DESC""",
        (entity_type, entity_id),
    ).fetchall()
    return {"notes": [dict(r) for r in rows]}


@router.post("/api/notes")
async def create_note(
    body: dict,
    member: dict = Depends(get_current_member),
):
    entity_type = body.get("entity_type")
    entity_id = body.get("entity_id")
    note_body = body.get("body", "").strip()
    mentioned = body.get("mentioned_member_ids", [])

    if entity_type not in _VALID_NOTE_ENTITY_TYPES:
        raise HTTPException(400, f"Invalid entity_type. Must be one of: {', '.join(sorted(_VALID_NOTE_ENTITY_TYPES))}")
    if not entity_id:
        raise HTTPException(400, "entity_id is required")
    if not note_body:
        raise HTTPException(400, "body is required")

    if not isinstance(mentioned, list):
        mentioned = []

    storage.db.execute(
        """INSERT INTO internal_notes (entity_type, entity_id, author_id, body, mentioned_member_ids)
           VALUES (?, ?, ?, ?, ?::jsonb)""",
        (entity_type, entity_id, member["id"], note_body, json.dumps(mentioned)),
    )
    storage.db.commit()
    return {"ok": True}


@router.delete("/api/notes/{note_id}")
async def delete_note(
    note_id: int,
    member: dict = Depends(get_current_member),
):
    row = storage.db.execute(
        "SELECT author_id FROM internal_notes WHERE id = ?", (note_id,)
    ).fetchone()
    if not row:
        raise HTTPException(404, "Note not found")
    if row["author_id"] != member["id"]:
        raise HTTPException(403, "Only the original author can delete this note")
    storage.db.execute("DELETE FROM internal_notes WHERE id = ?", (note_id,))
    storage.db.commit()
    return {"ok": True}
