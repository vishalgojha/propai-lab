"""Deterministic broker merge agent.

Finds brokers who are likely the same person:
- Same phone number across different identity keys
- Same sender_jid in raw_messages resolving to different brokers

Creates merge suggestions into the ai_suggestions queue.
"""

import json
import re
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from lab.storage.base import Storage


def check_for_broker_merge(storage: "Storage", broker_id: int | None = None) -> None:
    if broker_id:
        _check_single_broker(storage, broker_id)
    else:
        _scan_all_brokers(storage)


def _check_single_broker(storage: "Storage", broker_id: int) -> None:
    """Called after a new parsed message updates the broker graph."""
    row = storage.db.execute(
        "SELECT id, canonical_name, identity_key, primary_phone FROM brokers WHERE id = ?",
        (broker_id,),
    ).fetchone()
    if not row:
        return

    phone = row["primary_phone"]
    identity_key = row["identity_key"]
    canonical_name = row["canonical_name"]
    candidates = []

    if phone:
        candidates = storage.db.execute(
            """SELECT id, canonical_name, identity_key, primary_phone, observation_count
               FROM brokers
               WHERE primary_phone = ? AND id != ? AND identity_key != ?
               ORDER BY observation_count DESC
               LIMIT 5""",
            (phone, broker_id, identity_key),
        ).fetchall()

    if not candidates:
        jid_brokers = _find_brokers_by_jid(storage, canonical_name)
        for other_id in jid_brokers:
            if other_id != broker_id:
                candidates.extend(
                    storage.db.execute(
                        "SELECT id, canonical_name, identity_key, primary_phone, observation_count "
                        "FROM brokers WHERE id = ?",
                        (other_id,),
                    ).fetchall()
                )

    if not candidates:
        return

    for cand in candidates:
        _create_merge_suggestion(storage, row, cand)


def _scan_all_brokers(storage: "Storage") -> None:
    """Full scan for historical merge candidates (runs on startup)."""
    brokers = storage.db.execute(
        "SELECT id, canonical_name, identity_key, primary_phone, observation_count FROM brokers"
    ).fetchall()

    phone_map: dict[str, list] = {}
    for b in brokers:
        if b["primary_phone"]:
            phone_map.setdefault(b["primary_phone"], []).append(b)

    for phone, group in phone_map.items():
        if len(group) < 2:
            continue
        sorted_group = sorted(group, key=lambda x: -x["observation_count"])
        keeper = sorted_group[0]
        for dup in sorted_group[1:]:
            _create_merge_suggestion(storage, keeper, dup)

    for b in brokers:
        if b["primary_phone"]:
            continue
        jid_brokers = _find_brokers_by_jid(storage, b["canonical_name"])
        for other_id in jid_brokers:
            if other_id == b["id"]:
                continue
            cand = storage.db.execute(
                "SELECT id, canonical_name, identity_key, primary_phone, observation_count "
                "FROM brokers WHERE id = ?",
                (other_id,),
            ).fetchone()
            if cand:
                _create_merge_suggestion(storage, b, cand)


def _find_brokers_by_jid(storage: "Storage", name: str) -> set[int]:
    """Find broker IDs whose observations trace back to the same sender_jid."""
    rows = storage.db.execute(
        """SELECT DISTINCT b2.id
           FROM broker_observations bo1
           JOIN raw_messages r1 ON r1.id = bo1.raw_message_id
           JOIN broker_observations bo2 ON bo2.raw_message_id != bo1.raw_message_id
           JOIN raw_messages r2 ON r2.id = bo2.raw_message_id
           JOIN brokers b2 ON b2.id = bo2.broker_id
           WHERE r1.sender_jid IS NOT NULL
             AND r1.sender_jid != ''
             AND r1.sender_jid = r2.sender_jid
             AND bo1.broker_id != b2.id
             AND bo1.broker_id = (
                 SELECT id FROM brokers
                 WHERE canonical_name = ?
                 LIMIT 1
             )
           LIMIT 10""",
        (name,),
    ).fetchall()
    return {r["id"] for r in rows}


def _create_merge_suggestion(storage: "Storage", keeper: dict, dup: dict) -> None:
    existing = storage.db.execute(
        """SELECT id FROM ai_suggestions
           WHERE agent = 'merge_broker'
             AND suggestion_type = 'merge'
             AND status IN ('pending', 'approved')
             AND (source_data LIKE ? OR source_data LIKE ?)""",
        (f"%{keeper['id']}%", f"%{dup['id']}%"),
    ).fetchone()
    if existing:
        return

    total_obs = (keeper["observation_count"] or 0) + (dup["observation_count"] or 0)
    confidence = min(0.98, 0.80 + total_obs * 0.005)

    title = f"Merge broker: {dup['canonical_name']} → {keeper['canonical_name']}"
    description = (
        f"Broker #{dup['id']} \"{dup['canonical_name']}\" ({dup['observation_count']} obs) "
        f"and broker #{keeper['id']} \"{keeper['canonical_name']}\" "
        f"({keeper['observation_count']} obs) share "
    )
    if dup["primary_phone"] and dup["primary_phone"] == keeper.get("primary_phone"):
        description += f"phone {dup['primary_phone']}."
    else:
        description += "the same WhatsApp sender."

    source_data = json.dumps({
        "broker_ids": [dup["id"], keeper["id"]],
        "names": [dup["canonical_name"], keeper["canonical_name"]],
        "phones": [dup["primary_phone"], keeper["primary_phone"]],
        "identity_keys": [dup["identity_key"], keeper["identity_key"]],
    })

    proposal_data = json.dumps({
        "action": "merge_brokers",
        "keep_id": keeper["id"],
        "merge_id": dup["id"],
    })

    from lab.storage.base import AISuggestion
    sug = AISuggestion(
        agent="merge_broker",
        suggestion_type="merge",
        title=title,
        description=description,
        source_data=source_data,
        proposal_data=proposal_data,
        confidence=confidence,
    )
    storage.create_suggestion(sug)
