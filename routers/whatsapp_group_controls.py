"""WhatsApp group and extraction controls.

This router deliberately keeps group selection separate from the ingestor's
directory discovery. WhatsMeow may know about every group on the phone; broker
connections must explicitly confirm their group choices before extraction.
"""

import asyncio
import json
import logging
import os
import time
from datetime import datetime, timezone
from threading import Lock

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from routers.common import (
    _business_api_get_config_value,
    _mobile_digits,
    _normalize_real_phone,
    _require_org_permission,
    _resolve_active_organization_id,
    get_tenant_context,
    require_user,
    storage,
)

router = APIRouter(prefix="/api/onboarding", tags=["onboarding"])
_logger = logging.getLogger(__name__)

OVERLAP_WARNING_THRESHOLD = 0.60
SAMPLE_LIMIT = 200
GROUP_BACKFILL_PAGE_SIZE = 250
PROPAI_INTERNAL_CONNECTION_KEY = "phone-54ee9be74224"
_BROKER_PHONE_CACHE: tuple[float, set[str]] | None = None
_BROKER_PHONE_CACHE_LOCK = Lock()

class GroupRequest(BaseModel):
    whatsapp_connection_id: int
    group_jid: str
    group_name: str | None = None
    confirm_overlap: bool = False
    confirm_cap: bool = False


class GroupSelectionRequest(BaseModel):
    whatsapp_connection_id: int
    group_jids: list[str] = []
    confirm: bool = False


class ExtractionControlRequest(BaseModel):
    whatsapp_connection_id: int


_ACTIVE_GROUP_BACKFILLS: set[tuple[str, int, str]] = set()
_ACTIVE_GROUP_BACKFILLS_LOCK = Lock()
_NETWORK_OWNED_GROUP_CACHE: dict[tuple[str, str], tuple[float, bool]] = {}
_NETWORK_OWNED_GROUP_CACHE_LOCK = Lock()


def _claim_group_backfill(job_key: tuple[str, int, str]) -> bool:
    with _ACTIVE_GROUP_BACKFILLS_LOCK:
        if job_key in _ACTIVE_GROUP_BACKFILLS:
            return False
        _ACTIVE_GROUP_BACKFILLS.add(job_key)
        return True


def _release_group_backfill(job_key: tuple[str, int, str]) -> None:
    with _ACTIVE_GROUP_BACKFILLS_LOCK:
        _ACTIVE_GROUP_BACKFILLS.discard(job_key)


def _raw_row_value(row, key: str, default=None):
    if isinstance(row, dict):
        return row.get(key, default)
    return getattr(row, key, default)


def _row_payload(row) -> dict:
    payload = _raw_row_value(row, "raw_payload", {})
    if isinstance(payload, dict):
        return payload
    if isinstance(payload, str) and payload.strip():
        try:
            parsed = json.loads(payload)
            return parsed if isinstance(parsed, dict) else {}
        except (json.JSONDecodeError, TypeError):
            return {}
    return {}


def _matches_connected_group(row, group_jid: str, group_name: str) -> bool:
    payload = _row_payload(row)
    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    key = data.get("key") if isinstance(data, dict) and isinstance(data.get("key"), dict) else {}
    remote_jid = key.get("remoteJid") or payload.get("remoteJid") or payload.get("from") or ""
    raw_group_name = str(_raw_row_value(row, "group_name", "") or "")
    if remote_jid and remote_jid == group_jid:
        return True
    if remote_jid:
        return False
    return raw_group_name == group_name or raw_group_name == group_jid


def _backfill_connected_group(org_id: str, group_jid: str, group_name: str, connection_id: int) -> dict:
    """Best-effort historical parse for a group that has just been connected."""
    job_key = (org_id, connection_id, group_jid)
    if not _claim_group_backfill(job_key):
        return {"requested": 0, "matched": 0, "processed": 0, "skipped": 0, "failed": 0, "already_running": True}

    from extraction import process_raw_message
    from extraction_worker import context_from_raw

    previous_tenant = storage.tenant_id
    storage.tenant_id = org_id

    requested = 0
    matched = 0
    processed = 0
    skipped = 0
    failed = 0
    offset = 0

    try:
        while True:
            rows = storage.get_raw_messages(
                limit=GROUP_BACKFILL_PAGE_SIZE,
                offset=offset,
                group_name=group_name,
            )
            if not rows:
                break
            requested += len(rows)
            offset += len(rows)

            for row in rows:
                if not _matches_connected_group(row, group_jid, group_name):
                    continue
                matched += 1
                raw_id = _raw_row_value(row, "id")
                if not raw_id:
                    continue
                try:
                    if storage.get_parsed_by_raw(int(raw_id)):
                        skipped += 1
                        continue
                except Exception:
                    failed += 1
                    _logger.exception(
                        "Group backfill lookup failed for org=%s connection=%s group=%s raw_id=%s",
                        org_id, connection_id, group_jid, raw_id,
                    )
                    continue

                ctx = context_from_raw(row)
                ctx["tenant_id"] = org_id
                try:
                    process_raw_message(int(raw_id), ctx, storage=storage)
                    processed += 1
                except Exception:
                    failed += 1
                    _logger.exception(
                        "Group backfill failed for org=%s connection=%s group=%s raw_id=%s",
                        org_id, connection_id, group_jid, raw_id,
                    )
    finally:
        storage.tenant_id = previous_tenant
        _release_group_backfill(job_key)

    return {
        "requested": requested,
        "matched": matched,
        "processed": processed,
        "skipped": skipped,
        "failed": failed,
        "already_running": False,
    }


async def _schedule_group_backfill(org_id: str, connection_id: int, group_jid: str, group_name: str) -> None:
    try:
        result = await asyncio.to_thread(_backfill_connected_group, org_id, group_jid, group_name, connection_id)
        _logger.info(
            "Scheduled group backfill finished for org=%s connection=%s group=%s: %s",
            org_id,
            connection_id,
            group_jid,
            result,
        )
    except Exception:
        _logger.exception(
            "Scheduled group backfill crashed for org=%s connection=%s group=%s",
            org_id,
            connection_id,
            group_jid,
        )


def _connection(org_id: str, connection_id: int) -> dict:
    rows = (
        storage.client.table("org_whatsapp_connections")
        .select("*")
        .eq("id", connection_id)
        .eq("organization_id", org_id)
        .limit(1)
        .execute()
        .data
        or []
    )
    if not rows:
        raise HTTPException(404, "WhatsApp connection not found")
    return rows[0]


def _is_propai_connection(connection: dict | None) -> bool:
    return bool(connection and str(connection.get("broker_id") or "").strip() == PROPAI_INTERNAL_CONNECTION_KEY)


def _propai_owned_group_jids() -> set[str]:
    """Return groups captured by the platform-owned WhatsApp connection.

    The platform connection is in a separate internal organization, so the
    normal same-organization selection rows cannot identify its coverage.
    The connection's durable conversation directory is the source of truth.
    """
    try:
        rows = (
            storage.client.table("whatsapp_conversations")
            .select("conversation_jid")
            .eq("broker_id", PROPAI_INTERNAL_CONNECTION_KEY)
            .eq("conversation_type", "group")
            .limit(5000)
            .execute()
            .data
            or []
        )
        return {str(row.get("conversation_jid") or "").strip() for row in rows if row.get("conversation_jid")}
    except Exception:
        _logger.exception("Could not load PropAI-owned group coverage")
        return set()


def _tracked_broker_phones() -> set[str]:
    """Return the global distinct broker phone set used for novelty scoring."""
    global _BROKER_PHONE_CACHE
    now = time.time()
    with _BROKER_PHONE_CACHE_LOCK:
        if _BROKER_PHONE_CACHE and now - _BROKER_PHONE_CACHE[0] < 300:
            return set(_BROKER_PHONE_CACHE[1])
    phones: set[str] = set()
    offset = 0
    page_size = 1000
    while True:
        rows = (
            storage.client.table("brokers")
            .select("primary_phone")
            .range(offset, offset + page_size - 1)
            .execute()
            .data
            or []
        )
        for row in rows:
            phone = _normalize_real_phone(row.get("primary_phone"))
            if phone:
                phones.add(phone)
        if len(rows) < page_size:
            break
        offset += page_size
    with _BROKER_PHONE_CACHE_LOCK:
        _BROKER_PHONE_CACHE = (now, phones)
    return set(phones)


def _directory_novelty(org_id: str, group_jids: list[str]) -> dict[str, dict]:
    """Compute member novelty in bounded batches, independent of raw messages."""
    requested = {str(jid) for jid in group_jids if jid}
    try:
        rows = storage.db.execute(
            """
            WITH member_digits AS (
                SELECT DISTINCT
                    gm.group_id,
                    regexp_replace(COALESCE(gm.member_phone, ''), '[^0-9]', '', 'g') AS digits
                FROM group_members gm
                WHERE gm.tenant_id = ?
            ), normalized_members AS (
                SELECT DISTINCT
                    group_id,
                    CASE
                        WHEN length(digits) = 10 THEN digits
                        WHEN length(digits) = 12 AND digits LIKE '91%' THEN right(digits, 10)
                        WHEN length(digits) = 11 AND digits LIKE '0%' THEN right(digits, 10)
                        ELSE NULL
                    END AS phone
                FROM member_digits
            ), tracked AS (
                SELECT DISTINCT
                    CASE
                        WHEN length(digits) = 10 THEN digits
                        WHEN length(digits) = 12 AND digits LIKE '91%' THEN right(digits, 10)
                        WHEN length(digits) = 11 AND digits LIKE '0%' THEN right(digits, 10)
                        ELSE NULL
                    END AS phone
                FROM (
                    SELECT regexp_replace(COALESCE(primary_phone, ''), '[^0-9]', '', 'g') AS digits
                    FROM brokers
                    WHERE primary_phone IS NOT NULL
                ) broker_digits
            )
            SELECT
                members.group_id,
                COUNT(*)::integer AS member_count,
                COUNT(*) FILTER (WHERE tracked.phone IS NULL)::integer AS novel_member_count
            FROM normalized_members members
            LEFT JOIN tracked ON tracked.phone = members.phone
            WHERE members.phone IS NOT NULL
            GROUP BY members.group_id
            """,
            (org_id,),
        ).fetchall()
        result = {
            jid: {
                "member_count": 0,
                "tracked_member_count": 0,
                "overlap_percent": None,
                "novel_member_count": 0,
                "novelty_percent": None,
            }
            for jid in requested
        }
        for row in rows:
            group_id = str(row["group_id"] or "")
            if group_id not in requested:
                continue
            total = int(row["member_count"] or 0)
            novel = int(row["novel_member_count"] or 0)
            tracked_count = max(0, total - novel)
            result[group_id] = {
                "member_count": total,
                "tracked_member_count": tracked_count,
                "overlap_percent": round((tracked_count / total) * 100, 2) if total else None,
                "novel_member_count": novel,
                "novelty_percent": round((novel / total) * 100, 2) if total else None,
            }
        return result
    except Exception:
        # Keep compatibility with storage adapters that do not expose the SQL
        # aggregation RPC. The paged REST fallback remains exact past 1,000 rows.
        _logger.exception("Server-side group novelty aggregation failed for org=%s", org_id)

    tracked = _tracked_broker_phones()
    members_by_group: dict[str, set[str]] = {jid: set() for jid in requested}
    unique_jids = list(members_by_group)
    for start in range(0, len(unique_jids), 100):
        chunk = unique_jids[start:start + 100]
        offset = 0
        while True:
            page = (
                storage.client.table("group_members")
                .select("group_id,member_phone")
                .eq("tenant_id", org_id)
                .in_("group_id", chunk)
                .range(offset, offset + 999)
                .execute()
                .data
                or []
            )
            for row in page:
                group_id = str(row.get("group_id") or "")
                phone = _normalize_real_phone(row.get("member_phone"))
                if group_id in members_by_group and phone:
                    members_by_group[group_id].add(phone)
            if len(page) < 1000:
                break
            offset += 1000
    result = {}
    for group_jid, members in members_by_group.items():
        total = len(members)
        novel = sum(1 for phone in members if phone not in tracked)
        tracked_count = max(0, total - novel)
        result[group_jid] = {
            "member_count": total,
            "tracked_member_count": tracked_count,
            "overlap_percent": round((tracked_count / total) * 100, 2) if total else None,
            "novel_member_count": novel,
            "novelty_percent": round((novel / total) * 100, 2) if total else None,
        }
    return result


def _single_connection_directory_context(org_id: str, connection_id: int, broker_id: str) -> dict | None:
    """Allow tenant-wide historical recovery only when ownership is unambiguous."""
    rows = (
        storage.client.table("org_whatsapp_connections")
        .select("id,broker_id,instance_name,is_active")
        .eq("organization_id", org_id)
        .execute()
        .data
        or []
    )
    if len(rows) != 1:
        _logger.warning(
            "Skipping tenant-wide group directory recovery for org=%s connection=%s: %s connections",
            org_id,
            connection_id,
            len(rows),
        )
        return None
    candidate = rows[0]
    if int(candidate.get("id") or 0) != int(connection_id) or str(candidate.get("broker_id") or "") != broker_id:
        _logger.warning(
            "Skipping group directory recovery for org=%s connection=%s: connection identity mismatch",
            org_id,
            connection_id,
        )
        return None
    return candidate


def _recover_group_directory_from_members(org_id: str, broker_id: str, instance: str = "") -> list[dict]:
    """Recover a missing durable directory from tenant-scoped participant snapshots.

    The aggregate query avoids downloading every participant row. Recovered
    rows are persisted into ``whatsapp_conversations`` so subsequent requests
    use the normal broker-scoped directory path.
    """
    limit = max(1, int(os.getenv("PROPAI_GROUP_DIRECTORY_MAX", "1000")))
    rows = storage.db.execute(
        """
        SELECT
            gm.group_id AS conversation_jid,
            COALESCE((
                SELECT NULLIF(sj.group_name, '')
                FROM sync_jobs sj
                WHERE sj.source = 'whatsapp' AND sj.group_id = gm.group_id
                ORDER BY sj.updated_at DESC
                LIMIT 1
            ), gm.group_id) AS display_name,
            COUNT(DISTINCT gm.member_jid)::integer AS participants,
            MAX(gm.last_seen_at) AS member_snapshot_at
        FROM group_members gm
        WHERE gm.tenant_id = ?
        GROUP BY gm.group_id
        ORDER BY display_name
        LIMIT ?
        """,
        (org_id, limit),
    ).fetchall()
    recovered = [
        {
            "conversation_jid": str(row["conversation_jid"] or ""),
            "display_name": str(row["display_name"] or row["conversation_jid"] or ""),
            "metadata": {"participants": int(row["participants"] or 0)},
            "last_message_at": None,
        }
        for row in rows
        if row["conversation_jid"]
    ]
    if not recovered:
        return []
    try:
        storage.upsert_whatsapp_conversations(
            org_id,
            broker_id,
            instance,
            [
                {
                    "jid": row["conversation_jid"],
                    "type": "group",
                    "name": row["display_name"],
                    "source": "group_members_recovery",
                    "metadata": row["metadata"],
                }
                for row in recovered
            ],
        )
    except Exception:
        # The current response can still use the recovered rows; persistence is
        # an optimization and must not turn usable evidence into an empty UI.
        _logger.exception("Could not persist recovered group directory for org=%s broker=%s", org_id, broker_id)
    _logger.info(
        "Recovered %s WhatsApp groups from group_members for org=%s broker=%s",
        len(recovered),
        org_id,
        broker_id,
    )
    return recovered


def _covered_by_other_connection(group_jids: list[str], connection_id: int) -> set[str]:
    if not group_jids:
        return set()
    covered: set[str] = set()
    for start in range(0, len(group_jids), 100):
        rows = (
            storage.client.table("organization_group_connections")
            .select("group_jid,whatsapp_connection_id,network_owned,is_active,opted_out")
            .in_("group_jid", group_jids[start:start + 100])
            .eq("is_active", True)
            .execute()
            .data
            or []
        )
        for row in rows:
            if int(row.get("whatsapp_connection_id") or 0) == int(connection_id):
                continue
            if row.get("network_owned") or row.get("opted_out"):
                continue
            if row.get("group_jid"):
                covered.add(str(row["group_jid"]))
    return covered


def _group_directory(
    org_id: str,
    broker_id: str,
    connection_id: int,
    *,
    include_overlap: bool = True,
    allow_managed_selection: bool = False,
) -> list[dict]:
    rows: list[dict] = []
    try:
        rows = (
            storage.client.table("whatsapp_conversations")
            .select("conversation_jid,display_name,metadata,last_message_at")
            .eq("tenant_id", org_id)
            .eq("broker_id", broker_id)
            .eq("conversation_type", "group")
            .order("display_name")
            .limit(max(1, int(os.getenv("PROPAI_GROUP_DIRECTORY_MAX", "1000"))))
            .execute()
            .data
            or []
        )
        # Older history-sync rows sometimes stored the group JID as the
        # display name because that payload did not include WhatsApp's group
        # subject.  The group-directory sync stores the authoritative subject
        # in sync_jobs, so use it to repair those rows at read time.  This also
        # means existing workspaces recover without requiring a destructive
        # reconnect or a database backfill.
        group_jids = [str(row.get("conversation_jid") or "") for row in rows if row.get("conversation_jid")]
        directory_names: dict[str, str] = {}
        for start in range(0, len(group_jids), 100):
            try:
                name_rows = (
                    storage.client.table("sync_jobs")
                    .select("group_id,group_name,updated_at")
                    .eq("source", "whatsapp")
                    .in_("group_id", group_jids[start:start + 100])
                    .order("updated_at", desc=True)
                    .execute()
                    .data
                    or []
                )
            except Exception:
                _logger.exception("Could not read WhatsApp group subjects for org=%s", org_id)
                name_rows = []
            for name_row in name_rows:
                jid = str(name_row.get("group_id") or "").strip()
                name = str(name_row.get("group_name") or "").strip()
                if jid and name and jid not in directory_names and name != jid:
                    directory_names[jid] = name
        for row in rows:
            jid = str(row.get("conversation_jid") or "")
            current_name = str(row.get("display_name") or "").strip()
            if jid in directory_names and (not current_name or current_name == jid):
                row["display_name"] = directory_names[jid]
        # Some connections were created before the durable conversation
        # directory was populated. Tenant-wide historical evidence can only
        # be attributed when this is the tenant's sole connection.
        if not rows:
            fallback_context = _single_connection_directory_context(org_id, connection_id, broker_id)
            if fallback_context:
                rows = storage.get_whatsapp_conversations(
                    org_id,
                    ["group"],
                    max(1, int(os.getenv("PROPAI_GROUP_DIRECTORY_MAX", "1000"))),
                    "",
                    False,
                )
                if not rows:
                    rows = _recover_group_directory_from_members(
                        org_id,
                        broker_id,
                        str(fallback_context.get("instance_name") or ""),
                    )
        # Some older connections have durable group selection/member rows but
        # never received a whatsapp_conversations directory row.  Do not make
        # the onboarding UI depend on a live refresh to rediscover groups:
        # organization_group_connections is already scoped to this exact
        # connection and contains the authoritative group name/JID state.
        if not rows:
            try:
                persisted = (
                    storage.client.table("organization_group_connections")
                    .select("group_jid,group_name,is_active,opted_out,network_owned,updated_at")
                    .eq("organization_id", org_id)
                    .eq("whatsapp_connection_id", connection_id)
                    .order("group_name")
                    .limit(max(1, int(os.getenv("PROPAI_GROUP_DIRECTORY_MAX", "1000"))))
                    .execute()
                    .data
                    or []
                )
                rows = [
                    {
                        "conversation_jid": str(item.get("group_jid") or ""),
                        "display_name": str(item.get("group_name") or item.get("group_jid") or ""),
                        "metadata": {},
                        "last_message_at": item.get("updated_at"),
                    }
                    for item in persisted
                    if str(item.get("group_jid") or "").endswith("@g.us")
                ]
            except Exception:
                _logger.exception(
                    "Could not recover group directory from persisted connection rows for org=%s connection=%s",
                    org_id,
                    connection_id,
                )
        connection_rows = (
            storage.client.table("organization_group_connections")
            .select("group_jid,is_active,opted_out")
            .eq("organization_id", org_id)
            .eq("whatsapp_connection_id", connection_id)
            .execute()
            .data
            or []
        )
        connection_state = {str(row.get("group_jid") or ""): row for row in connection_rows}
        # If the platform number is itself a participant, PropAI already owns
        # this group's capture. This GET must remain read-only: persisting a
        # guard and updating raw_messages here made the directory request scan
        # the entire backlog and hit Postgres statement timeouts.
        propai_number = _business_api_get_config_value("whatsapp_business_number", "WABA_PHONE_NUMBER")
        network_owned_jids = storage.group_ids_with_member_phone(org_id, _mobile_digits(propai_number))
        network_owned_jids.update(_propai_owned_group_jids())
        connected = {
            group_jid
            for group_jid, state in connection_state.items()
            if state.get("is_active") and not state.get("opted_out")
        }

        # The Connections page only needs the persisted directory and current
        # selection state. Member novelty scans the participant registry and
        # broker corpus; keep that work behind the explicit overlap/check path
        # instead of allowing it to time out the initial directory request.
        # These signals are advisory. A slow/broken overlap query must never
        # turn a healthy WhatsApp directory into an empty response.
        novelty = {}
        covered_elsewhere: set[str] = set()
        if include_overlap:
            try:
                novelty = _directory_novelty(org_id, group_jids)
            except Exception:
                _logger.exception("Could not calculate group novelty for org=%s", org_id)
            try:
                if not _is_propai_connection(_connection(org_id, connection_id)):
                    covered_elsewhere = _covered_by_other_connection(group_jids, connection_id)
            except Exception:
                _logger.exception("Could not calculate cross-connection group coverage for org=%s", org_id)

        scored_groups = []
        for row in rows:
            group_jid = row.get("conversation_jid") or ""
            group_name = row.get("display_name") or group_jid
            metadata = row.get("metadata") if isinstance(row.get("metadata"), dict) else {}
            participants = metadata.get("participants", 0)
            last_message_at = row.get("last_message_at")
            is_connected = group_jid in connected
            opted_out = bool(connection_state.get(group_jid, {}).get("opted_out"))
            network_owned = group_jid in network_owned_jids or bool(connection_state.get(group_jid, {}).get("network_owned"))
            # Network ownership protects ordinary workspaces from selecting a
            # group already captured by PropAI's shared number. Super Admin
            # needs an explicit override so a pilot group can be selected on
            # this connection without changing the shared-network guard.
            opted_out = opted_out or (network_owned and not allow_managed_selection)
            novelty_data = novelty.get(group_jid, {})
            covered_by_other = group_jid in covered_elsewhere
            selectable = (
                (allow_managed_selection or not network_owned)
                and (allow_managed_selection or not covered_by_other)
            )

            scored_groups.append({
                "group_jid": group_jid,
                "group_name": group_name,
                "participants": participants,
                "last_message_at": last_message_at,
                "connected": is_connected,
                "opted_out": opted_out,
                "network_owned": network_owned,
                "covered_by_other_connection": covered_by_other,
                "selectable": selectable,
                **novelty_data,
                "suggestion": None,
            })

            if network_owned:
                scored_groups[-1]["selection_reason"] = (
                    "Already captured by PropAI's shared WhatsApp network; "
                    "Super Admin may explicitly select it for this connection"
                    if allow_managed_selection
                    else "Already captured by PropAI's shared WhatsApp network"
                )
            elif covered_by_other:
                scored_groups[-1]["selection_reason"] = "Already selected on another active WhatsApp connection"

        # Selection is deliberately manual. Keep confirmed groups visible first,
        # then use a neutral alphabetical order rather than recommending from
        # names, group size, recency, or inferred member novelty.
        ranked = sorted(
            scored_groups,
            key=lambda group: (
                not bool(group.get("connected")),
                str(group.get("group_name") or "").casefold(),
            ),
        )
        # Detailed sender overlap performs sampling and registry lookups for
        # many groups. It is useful on explicit checks, but must not block the
        # initial selection directory request.
        if include_overlap:
            try:
                _attach_directory_overlap(org_id, ranked)
            except Exception:
                _logger.exception("Could not attach group overlap signals for org=%s", org_id)
        for group in ranked:
            if group.get("selection_reason"):
                continue
            reason_by_status = {
                "high_overlap": "High sender overlap with PropAI's known broker network; likely duplicate reach",
                "moderate_overlap": "Some sender overlap with PropAI's known broker network",
                "new_reach": "Likely new broker reach for this workspace",
            }
            group["selection_reason"] = reason_by_status.get(
                group.get("overlap_status"),
                "No recent sender evidence; review this group before selecting it",
            )
        return ranked
    except Exception:
        _logger.exception("Group directory lookup failed for org=%s connection=%s broker=%s", org_id, connection_id, broker_id)
        # The durable conversation rows are sufficient to render the picker.
        # Do not turn a failure in advisory enrichment, overlap scoring, or a
        # stale optional column into an empty directory and make the user
        # believe WhatsApp has no groups.
        if rows:
            return [
                {
                    "group_jid": str(row.get("conversation_jid") or ""),
                    "group_name": str(row.get("display_name") or row.get("conversation_jid") or ""),
                    "participants": (
                        (row.get("metadata") or {}).get("participants", 0)
                        if isinstance(row.get("metadata"), dict)
                        else 0
                    ),
                    "last_message_at": row.get("last_message_at"),
                    "connected": False,
                    "opted_out": False,
                    "network_owned": False,
                    "covered_by_other_connection": False,
                    "selectable": True,
                    "selection_reason": "Review this group before selecting it",
                }
                for row in rows
                if row.get("conversation_jid")
            ]
        return []


def _sample_senders(org_id: str, group_name: str, group_jid: str = "") -> list[str]:
    rows = []
    for identity in dict.fromkeys([group_name, group_jid]):
        if not identity:
            continue
        rows.extend(
            storage.client.table("raw_messages")
            .select("sender_phone,sender_jid")
            .eq("tenant_id", org_id)
            .eq("group_name", identity)
            .order("created_at", desc=True)
            .limit(SAMPLE_LIMIT)
            .execute()
            .data
            or []
        )
    phones = set()
    for row in rows:
        phone = _normalize_real_phone(row.get("sender_phone"))
        if not phone:
            phone = _normalize_real_phone(row.get("sender_jid"))
        if phone:
            phones.add(phone)
    return sorted(phones)


def _overlap(org_id: str, group_name: str, group_jid: str = "") -> dict:
    sample = _sample_senders(org_id, group_name, group_jid)
    known = set()
    if sample:
        known_rows = (
            storage.client.table("network_broker_registry")
            .select("broker_phone")
            .in_("broker_phone", sample)
            .execute()
            .data
            or []
        )
        known = {row.get("broker_phone") for row in known_rows}
    score = len(known) / len(sample) if sample else 0.0
    return {
        "sample_count": len(sample),
        "shared_count": len(known),
        "overlap_score": round(score, 5),
        "high_overlap": bool(sample) and score >= OVERLAP_WARNING_THRESHOLD,
        "sample_phones": sample,
    }


def _attach_directory_overlap(org_id: str, groups: list[dict], limit: int = 20) -> None:
    """Add duplicate/new-reach signals with bounded batched lookups.

    The old implementation called _overlap once per candidate, and each call
    sampled raw_messages then queried network_broker_registry. On a directory
    of 20 candidates that became 40+ sequential Supabase requests.
    """
    candidates = [group for group in groups if group["connected"]]
    candidates += [group for group in groups if not group["connected"]][:limit]
    if not candidates:
        return

    identities = sorted({
        identity
        for group in candidates
        for identity in (group.get("group_name", ""), group.get("group_jid", ""))
        if identity
    })
    samples_by_identity: dict[str, list[str]] = {identity: [] for identity in identities}
    try:
        raw_rows = (
            storage.client.table("raw_messages")
            .select("group_name,sender_phone,sender_jid")
            .eq("tenant_id", org_id)
            .in_("group_name", identities)
            .order("created_at", desc=True)
            .limit(min(1000, max(SAMPLE_LIMIT * len(identities), SAMPLE_LIMIT)))
            .execute()
            .data
            or []
        )
        for row in raw_rows:
            identity = str(row.get("group_name") or "")
            if identity not in samples_by_identity or len(samples_by_identity[identity]) >= SAMPLE_LIMIT:
                continue
            phone = _normalize_real_phone(row.get("sender_phone")) or _normalize_real_phone(row.get("sender_jid"))
            if phone and phone not in samples_by_identity[identity]:
                samples_by_identity[identity].append(phone)
    except Exception:
        pass

    all_sample_phones = sorted({phone for phones in samples_by_identity.values() for phone in phones})
    try:
        known = {
            row.get("broker_phone")
            for row in (
                storage.client.table("network_broker_registry")
                .select("broker_phone")
                .in_("broker_phone", all_sample_phones)
                .execute()
                .data
                or []
            )
        } if all_sample_phones else set()
    except Exception:
        known = set()

    for group in candidates:
        sample = sorted({
            phone
            for identity in (group.get("group_name", ""), group.get("group_jid", ""))
            for phone in samples_by_identity.get(identity, [])
        })
        overlap_score = len(set(sample) & known) / len(sample) if sample else 0.0
        if not sample:
            status = "unknown"
        elif overlap_score >= OVERLAP_WARNING_THRESHOLD:
            status = "high_overlap"
        elif overlap_score >= 0.30:
            status = "moderate_overlap"
        else:
            status = "new_reach"
        group.update({
            "overlap_score": round(overlap_score, 5),
            "overlap_sample_count": len(sample),
            "overlap_shared_count": len(set(sample) & known),
            "overlap_status": status,
        })


def _upsert_registry(org_id: str, group_jid: str, phones: list[str]) -> None:
    now = datetime.now(timezone.utc).isoformat()
    for phone in phones:
        storage.client.table("network_broker_registry").upsert({
            "broker_phone": phone,
            "last_seen_at": now,
            "updated_at": now,
        }, on_conflict="broker_phone").execute()
        storage.client.table("network_broker_group_presence").upsert({
            "broker_phone": phone,
            "organization_id": org_id,
            "group_jid": group_jid,
            "last_seen_at": now,
            "source": "onboarding_sample",
        }, on_conflict="broker_phone,organization_id,group_jid").execute()

        presence = (
            storage.client.table("network_broker_group_presence")
            .select("organization_id,group_jid")
            .eq("broker_phone", phone)
            .execute()
            .data
            or []
        )
        tenants = {row.get("organization_id") for row in presence}
        groups = {(row.get("organization_id"), row.get("group_jid")) for row in presence}
        storage.client.table("network_broker_registry").update({
            "tenant_count": len(tenants),
            "group_count": len(groups),
            "confidence": min(1.0, len(groups) / 5),
            "last_seen_at": now,
            "updated_at": now,
        }).eq("broker_phone", phone).execute()


def _organization_has_unlimited_group_access(org_id: str) -> bool:
    """Return whether this workspace is owned by a platform super-admin."""
    try:
        organization = storage.get_organization(org_id)
        owner_user_id = str((organization or {}).get("owner_user_id") or "").strip()
        if owner_user_id and storage.is_super_admin(owner_user_id):
            return True
        # Legacy workspaces may predate owner_user_id. Their active membership
        # remains authoritative and is the shape used by the affected account.
        return bool(storage.organization_has_super_admin(org_id))
    except Exception:
        _logger.exception("could not resolve unlimited group access for org=%s", org_id)
        return False


def _cap_state(org_id: str, connection_id: int, *, unlimited: bool = False) -> dict:
    """Return selection state; group count is intentionally not hard-limited."""
    connection = _connection(org_id, connection_id)
    if unlimited or _is_propai_connection(connection):
        return {
            "tier": "platform_admin" if unlimited else "internal",
            "cap": None,
            "opted_out_count": 0,
            "selected_count": 0,
            "remaining": None,
            "overridden": True,
            # Super Admins have no count cap, but still choose groups
            # explicitly before extraction starts.
            "unlimited": False,
            "soft_warning_at_cap": False,
            "hard_block": False,
        }
    rows = (
        storage.client.table("organization_group_connections")
        .select("id,is_active,opted_out", count="exact")
        .eq("organization_id", org_id)
        .eq("whatsapp_connection_id", connection_id)
        .execute()
    )
    data = rows.data or []
    opted_out_count = sum(1 for row in data if row.get("opted_out"))
    selected_count = sum(1 for row in data if row.get("is_active") and not row.get("opted_out"))
    return {
        "tier": "starter",
        "cap": None,
        "opted_out_count": opted_out_count,
        "selected_count": selected_count,
        "remaining": None,
        "overridden": False,
        "unlimited": False,
        "soft_warning_at_cap": False,
        "hard_block": False,
    }


def extraction_allowed_for_group(
    org_id: str,
    group_jid: str,
    group_name: str,
    broker_id: str = "",
    *,
    message_from_me: bool = False,
    sender_phone: str = "",
) -> bool:
    """Enforce the selected-group policy at message-ingestion time.

    Connections are deny-by-default until the broker explicitly confirms
    groups. There is no group-count cap; broker_id is required to distinguish
    multiple WhatsApp connections belonging to the same organization.
    """
    connection = None
    if broker_id:
        connection = storage.get_org_whatsapp_connection_by_broker_id(broker_id)
        if connection and _is_propai_connection(connection):
            return True
        if connection:
            selected = (
                storage.client.table("organization_group_connections")
                .select("id")
                .eq("organization_id", org_id)
                .eq("whatsapp_connection_id", connection.get("id"))
                .eq("group_jid", group_jid)
                .eq("is_active", True)
                .eq("opted_out", False)
                .limit(1)
                .execute()
                .data
                or []
            )
            return bool(selected)

    # Legacy callers without broker_id retain the previous explicit opt-out
    # lookup; the webhook always supplies broker_id for capped enforcement.
    # Enforce the platform-owned guard in the worker path as well as in the
    # onboarding UI. This covers a group that starts receiving messages before
    # anyone opens the Connections screen.
    propai_number = _mobile_digits(_business_api_get_config_value("whatsapp_business_number", "WABA_PHONE_NUMBER"))
    cache_key = (str(org_id), str(group_jid or group_name))
    now_ts = time.time()
    with _NETWORK_OWNED_GROUP_CACHE_LOCK:
        cached = _NETWORK_OWNED_GROUP_CACHE.get(cache_key)
    if cached and now_ts - cached[0] < 300:
        network_owned = cached[1]
    else:
        member_group_lookup = getattr(storage, "group_ids_with_member_phone", None)
        network_owned = bool(
            member_group_lookup
            and group_jid
            and group_jid in member_group_lookup(org_id, propai_number)
        )
        with _NETWORK_OWNED_GROUP_CACHE_LOCK:
            _NETWORK_OWNED_GROUP_CACHE[cache_key] = (now_ts, network_owned)
    if network_owned:
        return False

    opted_out = (
        storage.client.table("organization_group_connections")
        .select("id")
        .eq("organization_id", org_id)
        .eq("group_jid", group_jid)
        .eq("opted_out", True)
        .limit(1)
        .execute()
        .data
        or []
    )
    if opted_out:
        return False
    return not bool(
        storage.client.table("organization_group_connections")
        .select("id")
        .eq("organization_id", org_id)
        .eq("group_name", group_name)
        .eq("opted_out", True)
        .limit(1)
        .execute()
        .data
    )


@router.get("/group-cap")
async def group_cap(
    whatsapp_connection_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = "unknown"
    try:
        # get_tenant_context has already validated the active tenant. Reusing
        # it avoids a second synchronous Supabase organization lookup on the
        # connections page's critical path. Only legacy requests without a
        # tenant header need the fallback resolver, and that work stays off
        # the event loop.
        org_id = str(tenant_id or "").strip()
        if not org_id:
            org_id = await asyncio.wait_for(
                asyncio.to_thread(_resolve_active_organization_id, user, tenant_id),
                timeout=5,
            )
        await _require_org_permission(user, org_id, "manage_whatsapp")
        _connection(org_id, whatsapp_connection_id)
        unlimited = await asyncio.to_thread(_organization_has_unlimited_group_access, org_id)
        return _cap_state(org_id, whatsapp_connection_id, unlimited=unlimited)
    except HTTPException:
        raise
    except Exception:
        _logger.exception("group_cap failed for org=%s connection=%s", org_id, whatsapp_connection_id)
        return {
            "tier": "unknown",
            "cap": None,
            "opted_out_count": 0,
            "remaining": None,
            "overridden": True,
            "unlimited": True,
            "soft_warning_at_cap": False,
            "hard_block": False,
        }


@router.get("/groups")
async def onboarding_groups(
    whatsapp_connection_id: int,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = "unknown"
    try:
        # get_tenant_context has already validated the active tenant. Reusing
        # it avoids a second synchronous organization lookup on the critical
        # path. Only legacy requests without a tenant need the fallback.
        org_id = str(tenant_id or "").strip()
        if not org_id:
            org_id = await asyncio.wait_for(
                asyncio.to_thread(_resolve_active_organization_id, user, tenant_id),
                timeout=5,
            )
        await _require_org_permission(user, org_id, "manage_whatsapp")
        connection = await asyncio.to_thread(_connection, org_id, whatsapp_connection_id)
        is_super_admin = await asyncio.to_thread(storage.is_super_admin, user["id"])
        # This endpoint is on the connections page's critical path. Do not
        # block directory rendering on organization-owner/cap lookups or
        # advisory overlap work. There is no group-count cap; the selected and
        # opted-out counts can be derived from the already-loaded directory.
        groups = await asyncio.wait_for(asyncio.to_thread(
            _group_directory,
            org_id,
            str(connection.get("broker_id") or ""),
            whatsapp_connection_id,
            include_overlap=False,
            allow_managed_selection=is_super_admin,
        ), timeout=8)
        cap = {
            "tier": "workspace",
            "cap": None,
            "opted_out_count": sum(1 for group in groups if group.get("opted_out")),
            "selected_count": sum(1 for group in groups if group.get("connected") and not group.get("opted_out")),
            "remaining": None,
            "overridden": False,
            "unlimited": False,
            "soft_warning_at_cap": False,
            "hard_block": False,
        }
        return {
            "groups": groups,
            "extraction_status": connection.get("extraction_status") or "stopped",
            **cap,
        }
    except HTTPException:
        raise
    except Exception:
        _logger.exception("onboarding_groups failed for org=%s connection=%s", org_id, whatsapp_connection_id)
        return {
            "groups": [],
            "tier": "unknown",
            "cap": None,
            "opted_out_count": 0,
            "remaining": None,
            "overridden": True,
            "unlimited": True,
            "soft_warning_at_cap": False,
            "hard_block": False,
            "extraction_status": "stopped",
        }


def _set_extraction_status(org_id: str, connection_id: int, status: str) -> dict:
    connection = _connection(org_id, connection_id)
    if status == "running" and not _is_propai_connection(connection):
        selected = (
            storage.client.table("organization_group_connections")
            .select("id")
            .eq("organization_id", org_id)
            .eq("whatsapp_connection_id", connection_id)
            .eq("is_active", True)
            .eq("opted_out", False)
            .limit(1)
            .execute()
            .data
            or []
        )
        if not selected:
            raise HTTPException(400, "Select and confirm at least one WhatsApp group before starting extraction")
    updated = storage.update_org_whatsapp_connection(connection_id, {
        "extraction_status": status,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    })
    if not updated:
        raise HTTPException(404, "WhatsApp connection not found")
    return {
        "ok": True,
        "whatsapp_connection_id": connection_id,
        "extraction_status": updated.get("extraction_status", status),
        "message": {
            "running": "Extraction started. New and queued messages will be processed.",
            "paused": "Extraction paused. Queued messages are preserved.",
            "stopped": "Extraction stopped. Queued messages are preserved.",
        }[status],
    }


def _set_group_extraction_suppressed(org_id: str, group_jid: str, suppressed: bool) -> None:
    """Suppress/resume queued rows without deleting raw WhatsApp history."""
    try:
        storage.set_raw_group_extraction_suppressed(org_id, group_jid, suppressed)
    except Exception:
        _logger.exception("queued group extraction update failed for org=%s group=%s", org_id, group_jid)


@router.post("/extraction/start")
async def start_extraction(
    body: ExtractionControlRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    return await asyncio.to_thread(_set_extraction_status, org_id, body.whatsapp_connection_id, "running")


@router.post("/extraction/pause")
async def pause_extraction(
    body: ExtractionControlRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    return await asyncio.to_thread(_set_extraction_status, org_id, body.whatsapp_connection_id, "paused")


@router.post("/extraction/stop")
async def stop_extraction(
    body: ExtractionControlRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    return await asyncio.to_thread(_set_extraction_status, org_id, body.whatsapp_connection_id, "stopped")


@router.post("/groups/check")
async def check_group(
    body: GroupRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    connection = _connection(org_id, body.whatsapp_connection_id)
    is_super_admin = await asyncio.to_thread(storage.is_super_admin, user["id"])
    unlimited = await asyncio.to_thread(_organization_has_unlimited_group_access, org_id)
    groups = _group_directory(
        org_id,
        str(connection.get("broker_id") or ""),
        body.whatsapp_connection_id,
        allow_managed_selection=is_super_admin,
    )
    group = next((item for item in groups if item["group_jid"] == body.group_jid), None)
    if not group:
        raise HTTPException(404, "Group is not available on this WhatsApp connection")
    overlap = _overlap(org_id, group["group_name"], group["group_jid"])
    return {
        "group": group,
        **overlap,
        "threshold": OVERLAP_WARNING_THRESHOLD,
        "cap": _cap_state(org_id, body.whatsapp_connection_id, unlimited=unlimited),
    }


@router.post("/groups/select")
async def select_groups(
    body: GroupSelectionRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Persist the broker's explicitly confirmed group choices."""
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    connection = _connection(org_id, body.whatsapp_connection_id)
    is_super_admin = await asyncio.to_thread(storage.is_super_admin, user["id"])
    unlimited = await asyncio.to_thread(_organization_has_unlimited_group_access, org_id)
    requested = list(dict.fromkeys(str(jid).strip() for jid in body.group_jids if str(jid).strip()))
    if not body.confirm:
        raise HTTPException(400, "Group selection must be explicitly confirmed")
    directory = await asyncio.to_thread(
        _group_directory,
        org_id,
        str(connection.get("broker_id") or ""),
        body.whatsapp_connection_id,
        include_overlap=False,
        allow_managed_selection=is_super_admin,
    )
    by_jid = {str(group.get("group_jid")): group for group in directory}
    invalid = [jid for jid in requested if jid not in by_jid]
    if invalid:
        raise HTTPException(400, "One or more selected groups are not on this WhatsApp connection")
    blocked = [
        jid for jid in requested
        if not by_jid[jid].get("selectable", True)
    ]
    if blocked:
        raise HTTPException(409, "A selected group is already covered by PropAI or another active connection")

    now = datetime.now(timezone.utc).isoformat()
    if not _is_propai_connection(connection):
        storage.client.table("organization_group_connections").update({
            "is_active": False,
            "opted_out": True,
            "updated_at": now,
        }).eq("organization_id", org_id).eq("whatsapp_connection_id", body.whatsapp_connection_id).execute()

    if requested:
        storage.client.table("organization_group_connections").upsert([
            {
                "organization_id": org_id,
                "whatsapp_connection_id": body.whatsapp_connection_id,
                "group_jid": jid,
                "group_name": by_jid[jid].get("group_name") or jid,
                "is_active": True,
                "opted_out": False,
                "network_owned": False,
                "updated_at": now,
                "connected_at": now,
            }
            for jid in requested
        ], on_conflict="organization_id,whatsapp_connection_id,group_jid").execute()

    if not _is_propai_connection(connection):
        for group in directory:
            jid = str(group.get("group_jid") or "")
            if not jid or jid in requested or not group.get("selectable", True):
                continue
            _set_group_extraction_suppressed(org_id, jid, True)
        for jid in requested:
            _set_group_extraction_suppressed(org_id, jid, False)

    storage.update_org_whatsapp_connection(body.whatsapp_connection_id, {
        "group_audit_required": False,
        "group_audit_completed_at": now,
        "updated_at": now,
    })
    return {
        "ok": True,
        "selected_group_jids": requested,
        "selected_count": len(requested),
        "cap": _cap_state(org_id, body.whatsapp_connection_id, unlimited=unlimited),
    }


@router.post("/groups/connect")
async def connect_group(
    body: GroupRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Deprecated: extraction is explicitly started after group review."""
    raise HTTPException(
        status_code=410,
        detail="Group connection is no longer supported. Pair the phone, review group opt-outs, then start extraction.",
    )


@router.post("/groups/opt-out")
async def opt_out_group(
    body: GroupRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Mark a WhatsApp group as opted-out from extraction. Default is all groups
    eligible, and users may exclude any number of groups per connection."""
    try:
        org_id = _resolve_active_organization_id(user, tenant_id)
        await _require_org_permission(user, org_id, "manage_whatsapp")
        connection = _connection(org_id, body.whatsapp_connection_id)
        unlimited = await asyncio.to_thread(_organization_has_unlimited_group_access, org_id)
        # Persistence must not depend on the live/durable conversation
        # directory being available. A directory refresh can be temporarily
        # unavailable while the phone is reconnecting, but the user must still
        # be able to suppress a known group by JID.
        group = {
            "group_jid": body.group_jid,
            "group_name": body.group_name or body.group_jid,
        }
        try:
            groups = _group_directory(
                org_id,
                str(connection.get("broker_id") or ""),
                body.whatsapp_connection_id,
                include_overlap=False,
            )
            directory_group = next(
                (item for item in groups if item["group_jid"] == body.group_jid),
                None,
            )
            if directory_group:
                group = directory_group
        except Exception:
            _logger.exception("group directory unavailable during opt-out; persisting by jid")

        # Overlap is advisory only; it must never turn a successful opt-out
        # into a failed request.
        try:
            overlap = _overlap(org_id, group["group_name"], group["group_jid"])
        except Exception:
            _logger.exception("overlap lookup failed during opt-out")
            overlap = {}

        now = datetime.now(timezone.utc).isoformat()
        row = storage.client.table("organization_group_connections").upsert({
            "organization_id": org_id,
            "whatsapp_connection_id": body.whatsapp_connection_id,
            "group_jid": body.group_jid,
            "group_name": group["group_name"],
            "opted_out": True,
            "is_active": False,
            "updated_at": now,
            "connected_at": now,
        }, on_conflict="organization_id,whatsapp_connection_id,group_jid").execute()
        _set_group_extraction_suppressed(org_id, body.group_jid, True)
        return {
            "ok": True,
            "group": group,
            "connection": (row.data or [None])[0],
            "cap": _cap_state(org_id, body.whatsapp_connection_id, unlimited=unlimited),
            "overlap": overlap,
            "opted_out": True,
        }
    except HTTPException:
        raise
    except Exception:
        _logger.exception("opt_out_group crashed for org=%s connection=%s group=%s", org_id, body.whatsapp_connection_id, body.group_jid)
        raise


@router.post("/groups/opt-in")
async def opt_in_group(
    body: GroupRequest,
    user: dict = Depends(require_user),
    tenant_id: str | None = Depends(get_tenant_context),
):
    """Clear an opt-out suppression. The group returns to the default extract-everything state."""
    org_id = _resolve_active_organization_id(user, tenant_id)
    await _require_org_permission(user, org_id, "manage_whatsapp")
    _connection(org_id, body.whatsapp_connection_id)
    connection = _connection(org_id, body.whatsapp_connection_id)
    unlimited = await asyncio.to_thread(_organization_has_unlimited_group_access, org_id)
    result = (
        storage.client.table("organization_group_connections")
        .update({"opted_out": False, "is_active": False, "updated_at": datetime.now(timezone.utc).isoformat()})
        .eq("organization_id", org_id)
        .eq("whatsapp_connection_id", body.whatsapp_connection_id)
        .eq("group_jid", body.group_jid)
        .eq("opted_out", True)
        .execute()
    )
    if not result.data:
        raise HTTPException(404, "Opted-out group not found")
    _set_group_extraction_suppressed(org_id, body.group_jid, False)
    return {
        "ok": True,
        "message": "Group re-enabled for extraction",
        "cap": _cap_state(org_id, body.whatsapp_connection_id, unlimited=unlimited),
    }
