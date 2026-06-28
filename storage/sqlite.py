"""SQLite implementation of the Storage interface."""

import json
import re
import sqlite3
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

from lab.storage.base import (
    Storage,
    RawMessage, ParsedObservation, ResolverDecision,
    Evaluation, SyncJob, SyncCheckpoint, AISuggestion,
    dict_to_dataclass,
)
from lab.inventory import listing_fingerprint, listing_label
from agents.duplicate_detector import check_for_duplicates
from agents.broker_merger import check_for_broker_merge


def _clean_person_name(name: str = "") -> str:
    clean = (name or "").strip()
    clean = re.sub(r"\s*\([^)]*(?:\+?\d|X{2,})[^)]*\)\s*", " ", clean, flags=re.I)
    clean = re.sub(r"\s*\+?\d[\d\s().-]{7,}\s*", " ", clean)
    clean = re.sub(r"\s{2,}", " ", clean).strip(" -")
    return clean


class SqliteStorage(Storage):
    """Single SQLite connection — not thread-safe, use one per process."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._db: sqlite3.Connection | None = None

    # ── Connection ─────────────────────────────────────────────

    @property
    def db(self) -> sqlite3.Connection:
        if self._db is None:
            self._db = sqlite3.connect(str(self.db_path), check_same_thread=False)
            self._db.row_factory = sqlite3.Row
            self._db.execute("PRAGMA journal_mode=WAL")
            self._db.execute("PRAGMA foreign_keys=ON")
        return self._db

    def close(self):
        if self._db is not None:
            self._db.close()
            self._db = None

    def _commit(self):
        self.db.commit()

    # ── Schema ─────────────────────────────────────────────────

    def init_schema(self):
        schema_path = Path(__file__).parent.parent / "schema.sql"
        self.db.executescript(schema_path.read_text())
        migs = [
            "ALTER TABLE resolver_decisions ADD COLUMN candidates TEXT DEFAULT '[]'",
            "ALTER TABLE resolver_decisions ADD COLUMN failure_category TEXT DEFAULT NULL",
            "ALTER TABLE resolver_decisions ADD COLUMN parser_confidence REAL DEFAULT 0.0",
            "ALTER TABLE resolver_decisions ADD COLUMN resolver_confidence REAL DEFAULT 0.0",
            "ALTER TABLE resolver_decisions ADD COLUMN final_confidence REAL DEFAULT 0.0",
            "ALTER TABLE raw_messages ADD COLUMN message_uid TEXT DEFAULT NULL",
            "ALTER TABLE raw_messages ADD COLUMN pipeline_version TEXT DEFAULT NULL",
            "ALTER TABLE raw_messages ADD COLUMN synced_at TEXT DEFAULT NULL",
            "ALTER TABLE parsed_output ADD COLUMN developer TEXT DEFAULT ''",
            "ALTER TABLE raw_messages ADD COLUMN event_id TEXT DEFAULT NULL",
            "ALTER TABLE parsed_output ADD COLUMN event_id TEXT DEFAULT NULL",
            "ALTER TABLE resolver_decisions ADD COLUMN event_id TEXT DEFAULT NULL",
            "ALTER TABLE evaluations ADD COLUMN event_id TEXT DEFAULT NULL",
            "CREATE INDEX IF NOT EXISTS idx_raw_event_id ON raw_messages(event_id)",
            "CREATE INDEX IF NOT EXISTS idx_parsed_event_id ON parsed_output(event_id)",
            "CREATE INDEX IF NOT EXISTS idx_resolver_event_id ON resolver_decisions(event_id)",
            "CREATE INDEX IF NOT EXISTS idx_eval_event_id ON evaluations(event_id)",
            "ALTER TABLE parsed_output ADD COLUMN intent TEXT DEFAULT NULL",
            "ALTER TABLE parsed_output ADD COLUMN principal TEXT DEFAULT NULL",
            "ALTER TABLE parsed_output ADD COLUMN forwarded INTEGER DEFAULT 0",
            "ALTER TABLE parsed_output ADD COLUMN profile_name TEXT DEFAULT NULL",
            "DROP INDEX IF EXISTS idx_parsed_type",
            "CREATE INDEX IF NOT EXISTS idx_parsed_intent ON parsed_output(intent)",
            "ALTER TABLE evaluations ADD COLUMN expected_intent TEXT DEFAULT NULL",
            "ALTER TABLE evaluations ADD COLUMN expected_principal TEXT DEFAULT NULL",
            "ALTER TABLE evaluations ADD COLUMN extracted_intent TEXT DEFAULT NULL",
            "ALTER TABLE evaluations ADD COLUMN extracted_principal TEXT DEFAULT NULL",
            "ALTER TABLE parsed_output ADD COLUMN embedding BLOB DEFAULT NULL",
            "ALTER TABLE parsed_output ADD COLUMN location TEXT DEFAULT NULL",
            "ALTER TABLE parsed_output ADD COLUMN message_type TEXT DEFAULT NULL",
            "ALTER TABLE parsed_output ADD COLUMN listing_index INTEGER DEFAULT 0",
            "CREATE INDEX IF NOT EXISTS idx_parsed_listing ON parsed_output(raw_message_id, listing_index)",
            "ALTER TABLE listings ADD COLUMN location_label TEXT DEFAULT NULL",
            "ALTER TABLE listings ADD COLUMN latest_raw_message_id INTEGER DEFAULT NULL",
            "ALTER TABLE listings ADD COLUMN representative_raw_message_id INTEGER DEFAULT NULL",
            "ALTER TABLE listings ADD COLUMN observation_count INTEGER DEFAULT 0",
            "ALTER TABLE listings ADD COLUMN group_count INTEGER DEFAULT 0",
            "ALTER TABLE listings ADD COLUMN first_seen TEXT DEFAULT NULL",
            "ALTER TABLE listings ADD COLUMN last_seen TEXT DEFAULT NULL",
            "ALTER TABLE raw_messages ADD COLUMN sender_jid TEXT DEFAULT ''",
            "ALTER TABLE raw_messages ADD COLUMN sender_phone TEXT DEFAULT ''",
            "ALTER TABLE ai_suggestions ADD COLUMN rejection_reason TEXT DEFAULT NULL",
        ]
        for sql in migs:
            try:
                self.db.execute(sql)
            except sqlite3.OperationalError:
                pass
        # Backfill sender_jid from raw_payload for existing rows
        try:
            self.db.execute("""
                UPDATE raw_messages
                SET sender_jid = json_extract(raw_payload, '$.data.key.participant')
                WHERE sender_jid IS NULL OR sender_jid = ''
            """)
        except Exception:
            pass
        self._commit()

    # ── Broker graph ───────────────────────────────────────────

    @staticmethod
    def _broker_identity_key(name: str | None, phone: str | None) -> str | None:
        digits = re.sub(r"\D+", "", phone or "")
        if len(digits) >= 10:
            return f"phone:{digits[-10:]}"
        normalized_name = re.sub(r"\s+", " ", (name or "").strip().lower())
        if normalized_name:
            return f"name:{normalized_name}"
        return None

    @staticmethod
    def _broker_role(message_type: str | None, intent: str | None = None) -> str:
        if intent in {"SELL", "RENT", "COMMERCIAL", "PRE-LAUNCH"}:
            return "listing"
        if intent in {"BUY", "RENTAL_SEEKER"}:
            return "requirement"
        if message_type in {"SELLER", "RENTAL", "COMMERCIAL_SALE", "COMMERCIAL_RENTAL", "PRE_LAUNCH"}:
            return "listing"
        if message_type in {"REQUIREMENT", "RENTAL_SEEKER"}:
            return "requirement"
        return "unknown"

    def rebuild_broker_graph(self) -> dict:
        rows = self.db.execute(
            """SELECT p.id AS parsed_id, p.raw_message_id, p.message_type, p.intent,
                      p.broker_name, p.broker_phone, p.profile_name,
                      p.micro_market,
                      COALESCE(rd.building_name, p.building_name) AS building_name,
                      COALESCE(rd.landmark_name, p.landmark_name) AS landmark_name,
                      p.price, p.bhk, p.created_at,
                      r.group_name, r.sender, r.timestamp
               FROM parsed_output p
               JOIN raw_messages r ON r.id = p.raw_message_id
               LEFT JOIN resolver_decisions rd ON rd.parsed_id = p.id
               WHERE COALESCE(p.broker_name, p.profile_name, r.sender, '') != ''
               ORDER BY p.id"""
        ).fetchall()

        self.db.execute("DELETE FROM broker_building_stats")
        self.db.execute("DELETE FROM broker_market_stats")
        self.db.execute("DELETE FROM broker_observations")
        self.db.execute("DELETE FROM broker_aliases")
        self.db.execute("DELETE FROM broker_phones")
        existing_brokers = {
            row["identity_key"]: row["id"]
            for row in self.db.execute("SELECT id, identity_key FROM brokers").fetchall()
        }

        broker_rows: dict[str, list[dict]] = defaultdict(list)
        for row in rows:
            d = dict(row)
            name = d.get("broker_name") or d.get("profile_name") or d.get("sender")
            key = self._broker_identity_key(name, d.get("broker_phone"))
            if key:
                d["identity_key"] = key
                d["effective_broker_name"] = name
                broker_rows[key].append(d)

        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        broker_ids: dict[str, int] = {}
        for key, items in broker_rows.items():
            names: dict[str, int] = defaultdict(int)
            phones: dict[str, int] = defaultdict(int)
            groups = set()
            markets = set()
            prices: list[float] = []
            listing_count = requirement_count = rental_count = commercial_count = 0
            seen_times = []

            for item in items:
                name = (item.get("effective_broker_name") or "").strip()
                if name:
                    names[name] += 1
                phone = re.sub(r"\D+", "", item.get("broker_phone") or "")
                if len(phone) >= 10:
                    phones[phone[-10:]] += 1
                if item.get("group_name"):
                    groups.add(item["group_name"])
                if item.get("micro_market"):
                    markets.add(item["micro_market"])
                if item.get("price") is not None:
                    prices.append(float(item["price"]))
                role = self._broker_role(item.get("message_type"), item.get("intent"))
                if role == "listing":
                    listing_count += 1
                elif role == "requirement":
                    requirement_count += 1
                if item.get("intent") in {"RENT", "RENTAL_SEEKER"} or item.get("message_type") in {"RENTAL", "RENTAL_SEEKER"}:
                    rental_count += 1
                if item.get("intent") == "COMMERCIAL" or item.get("message_type") in {"COMMERCIAL_SALE", "COMMERCIAL_RENTAL"}:
                    commercial_count += 1
                seen_times.append(item.get("timestamp") or item.get("created_at") or "")

            canonical_name = max(names.items(), key=lambda kv: (kv[1], len(kv[0])))[0] if names else ""
            primary_phone = max(phones.items(), key=lambda kv: kv[1])[0] if phones else None
            avg_ticket = sum(prices) / len(prices) if prices else None
            seen_values = [t for t in seen_times if t]
            first_seen = min(seen_values) if seen_values else None
            last_seen = max(seen_values) if seen_values else None

            broker_id = existing_brokers.get(key)
            if broker_id:
                self.db.execute(
                    """UPDATE brokers
                       SET canonical_name = ?, primary_phone = ?, first_seen_at = ?,
                           last_seen_at = ?, observation_count = ?, listing_count = ?,
                           requirement_count = ?, rental_count = ?, commercial_count = ?,
                           group_count = ?, market_count = ?, avg_ticket = ?, updated_at = ?
                       WHERE id = ?""",
                    (canonical_name, primary_phone, first_seen, last_seen, len(items),
                     listing_count, requirement_count, rental_count, commercial_count,
                     len(groups), len(markets), avg_ticket, now, broker_id),
                )
            else:
                cur = self.db.execute(
                    """INSERT INTO brokers
                       (identity_key, canonical_name, primary_phone, first_seen_at, last_seen_at,
                        observation_count, listing_count, requirement_count, rental_count,
                        commercial_count, group_count, market_count, avg_ticket, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (key, canonical_name, primary_phone, first_seen, last_seen, len(items),
                     listing_count, requirement_count, rental_count, commercial_count,
                     len(groups), len(markets), avg_ticket, now),
                )
                broker_id = cur.lastrowid
            broker_ids[key] = broker_id

            for alias, count in names.items():
                alias_times = [
                    (item.get("timestamp") or item.get("created_at") or "")
                    for item in items
                    if (item.get("effective_broker_name") or "").strip() == alias
                ]
                alias_seen = [t for t in alias_times if t]
                self.db.execute(
                    """INSERT INTO broker_aliases
                       (broker_id, alias, observation_count, first_seen_at, last_seen_at)
                       VALUES (?,?,?,?,?)""",
                    (broker_id, alias, count,
                     min(alias_seen) if alias_seen else None,
                     max(alias_seen) if alias_seen else None),
                )

            for phone, count in phones.items():
                phone_times = [
                    (item.get("timestamp") or item.get("created_at") or "")
                    for item in items
                    if re.sub(r"\D+", "", item.get("broker_phone") or "")[-10:] == phone
                ]
                phone_seen = [t for t in phone_times if t]
                self.db.execute(
                    """INSERT INTO broker_phones
                       (broker_id, phone, observation_count, first_seen_at, last_seen_at)
                       VALUES (?,?,?,?,?)""",
                    (broker_id, phone, count,
                     min(phone_seen) if phone_seen else None,
                     max(phone_seen) if phone_seen else None),
                )

        for key, items in broker_rows.items():
            broker_id = broker_ids[key]
            market_stats: dict[str, dict] = defaultdict(lambda: {"obs": 0, "listing": 0, "req": 0, "prices": [], "last": ""})
            building_stats: dict[str, dict] = defaultdict(lambda: {"obs": 0, "listing": 0, "req": 0, "prices": [], "last": ""})

            for item in items:
                role = self._broker_role(item.get("message_type"), item.get("intent"))
                seen_at = item.get("timestamp") or item.get("created_at")
                self.db.execute(
                    """INSERT INTO broker_observations
                       (broker_id, parsed_id, raw_message_id, role, message_type, group_name,
                        micro_market, building_name, landmark_name, price, bhk, seen_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (broker_id, item["parsed_id"], item["raw_message_id"], role,
                     item.get("message_type"), item.get("group_name") or "",
                     item.get("micro_market"), item.get("building_name"),
                     item.get("landmark_name"), item.get("price"), item.get("bhk"), seen_at),
                )

                for stats, key_value in (
                    (market_stats, item.get("micro_market")),
                    (building_stats, item.get("building_name")),
                ):
                    if not key_value:
                        continue
                    bucket = stats[key_value]
                    bucket["obs"] += 1
                    if role == "listing":
                        bucket["listing"] += 1
                    elif role == "requirement":
                        bucket["req"] += 1
                    if item.get("price") is not None:
                        bucket["prices"].append(float(item["price"]))
                    if seen_at and seen_at > bucket["last"]:
                        bucket["last"] = seen_at

            for market, stat in market_stats.items():
                prices = stat["prices"]
                self.db.execute(
                    """INSERT INTO broker_market_stats
                       (broker_id, micro_market, observation_count, listing_count,
                        requirement_count, avg_ticket, last_seen_at)
                       VALUES (?,?,?,?,?,?,?)""",
                    (broker_id, market, stat["obs"], stat["listing"], stat["req"],
                     sum(prices) / len(prices) if prices else None, stat["last"] or None),
                )

            for building, stat in building_stats.items():
                prices = stat["prices"]
                self.db.execute(
                    """INSERT INTO broker_building_stats
                       (broker_id, building_name, observation_count, listing_count,
                        requirement_count, avg_ticket, last_seen_at)
                       VALUES (?,?,?,?,?,?,?)""",
                    (broker_id, building, stat["obs"], stat["listing"], stat["req"],
                     sum(prices) / len(prices) if prices else None, stat["last"] or None),
                )

        stale_keys = set(existing_brokers) - set(broker_rows)
        if stale_keys:
            placeholders = ",".join("?" for _ in stale_keys)
            self.db.execute(
                f"DELETE FROM brokers WHERE identity_key IN ({placeholders})",
                tuple(stale_keys),
            )

        self._commit()
        return {"brokers": len(broker_rows), "observations": sum(len(v) for v in broker_rows.values())}

    # ── Raw messages ───────────────────────────────────────────

    def get_raw_by_uid(self, message_uid: str) -> RawMessage | None:
        row = self.db.execute(
            "SELECT * FROM raw_messages WHERE message_uid = ?", (message_uid,)
        ).fetchone()
        return dict_to_dataclass(RawMessage, row) if row else None

    def save_raw_message(self, msg: RawMessage) -> int:
        if msg.message_uid:
            existing = self.db.execute(
                "SELECT id FROM raw_messages WHERE message_uid = ?", (msg.message_uid,)
            ).fetchone()
            if existing:
                return existing["id"]
        if not msg.event_id:
            msg.event_id = str(uuid.uuid4())
        cur = self.db.execute(
            """INSERT INTO raw_messages
               (group_name, sender, sender_jid, sender_phone, message, message_type, timestamp, source,
                raw_payload, message_uid, pipeline_version, synced_at, event_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (msg.group_name, msg.sender, msg.sender_jid, msg.sender_phone,
             msg.message, msg.message_type,
             msg.timestamp, msg.source, msg.raw_payload, msg.message_uid,
             msg.pipeline_version, msg.synced_at, msg.event_id)
        )
        self._commit()
        return cur.lastrowid

    def get_raw_message(self, id: int) -> RawMessage | None:
        row = self.db.execute(
            "SELECT * FROM raw_messages WHERE id = ?", (id,)
        ).fetchone()
        return dict_to_dataclass(RawMessage, row) if row else None

    def get_raw_messages(self, limit: int = 50, offset: int = 0,
                         source: str = "") -> list[RawMessage]:
        if source:
            rows = self.db.execute(
                "SELECT * FROM raw_messages WHERE source = ? ORDER BY id DESC LIMIT ? OFFSET ?",
                (source, limit, offset)
            ).fetchall()
        else:
            rows = self.db.execute(
                "SELECT * FROM raw_messages ORDER BY id DESC LIMIT ? OFFSET ?",
                (limit, offset)
            ).fetchall()
        return [dict_to_dataclass(RawMessage, r) for r in rows]

    def get_all_raw_for_replay(self) -> list[RawMessage]:
        rows = self.db.execute(
            "SELECT r.*, p.id as parsed_id FROM raw_messages r "
            "LEFT JOIN parsed_output p ON p.raw_message_id = r.id "
            "ORDER BY r.id"
        ).fetchall()
        return [dict_to_dataclass(RawMessage, r) for r in rows]

    # ── Parsed observations ────────────────────────────────────

    def save_parsed(self, obs: ParsedObservation) -> int:
        if not obs.event_id:
            raw = self.get_raw_message(obs.raw_message_id)
            if raw:
                obs.event_id = raw.event_id
        cur = self.db.execute(
            """INSERT INTO parsed_output
               (raw_message_id, message_type, intent, principal, bhk, price, price_unit, area_sqft,
                furnishing, location_raw, location, building_name, landmark_name, street_name,
                area, micro_market, developer, broker_name, broker_phone,
                profile_name, listing_index, forwarded, confidence, raw_payload, event_id, embedding)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (obs.raw_message_id, obs.message_type, obs.intent, obs.principal, obs.bhk,
             obs.price, obs.price_unit, obs.area_sqft, obs.furnishing, obs.location_raw,
             obs.location,
             obs.building_name, obs.landmark_name, obs.street_name,
             obs.area, obs.micro_market, obs.developer,
             obs.broker_name, obs.broker_phone,
             obs.profile_name, obs.listing_index,
             obs.forwarded,
             obs.confidence, obs.raw_payload, obs.event_id,
             obs.embedding)
        )
        parsed_id = cur.lastrowid
        self._commit()
        listing_id = self.upsert_listing_from_parsed(obs, parsed_id=parsed_id)
        if listing_id:
            try:
                check_for_duplicates(self, listing_id, parsed_id)
            except Exception:
                pass
        try:
            self.rebuild_broker_graph()
        except Exception:
            pass
        try:
            name = obs.broker_name or obs.profile_name
            if name:
                key = SqliteStorage._broker_identity_key(name, obs.broker_phone)
                if key:
                    row = self.db.execute(
                        "SELECT id FROM brokers WHERE identity_key = ?", (key,)
                    ).fetchone()
                    if row:
                        check_for_broker_merge(self, broker_id=row["id"])
        except Exception:
            pass
        try:
            from datetime import datetime, timedelta, timezone
            later = (datetime.now(timezone.utc) + timedelta(minutes=30)).strftime("%Y-%m-%dT%H:%M:%SZ")
            self.create_enrichment_job(parsed_id, obs.raw_message_id, later)
        except Exception:
            pass
        return parsed_id

    def _listing_summary_fields(self, obs: ParsedObservation, raw: RawMessage | None = None) -> dict:
        raw_sender = raw.sender if raw else ""
        return {
            "intent": obs.intent,
            "bhk": obs.bhk,
            "price": obs.price,
            "price_unit": obs.price_unit,
            "area_sqft": obs.area_sqft,
            "furnishing": obs.furnishing,
            "location_label": listing_label(obs) or obs.location_raw,
            "building_name": obs.building_name,
            "landmark_name": obs.landmark_name,
            "micro_market": obs.micro_market,
            "broker_name": obs.broker_name or raw_sender or obs.profile_name,
            "broker_phone": obs.broker_phone,
        }

    def upsert_listing_from_parsed(self, obs: ParsedObservation, parsed_id: int | None = None, commit: bool = True):
        raw = self.get_raw_message(obs.raw_message_id)
        if not raw:
            return None
        fingerprint = listing_fingerprint(obs, raw_sender=raw.sender, group_name=raw.group_name)
        seen_at = raw.timestamp or obs.created_at or ""
        summary = self._listing_summary_fields(obs, raw)
        row = self.db.execute(
            "SELECT id, first_seen, last_seen FROM listings WHERE fingerprint = ?",
            (fingerprint,)
        ).fetchone()
        if row:
            listing_id = row["id"]
            self.db.execute(
                """UPDATE listings SET
                       intent = COALESCE(?, intent),
                       bhk = COALESCE(?, bhk),
                       price = COALESCE(?, price),
                       price_unit = COALESCE(?, price_unit),
                       area_sqft = COALESCE(?, area_sqft),
                       furnishing = COALESCE(?, furnishing),
                       location_label = COALESCE(?, location_label),
                       building_name = COALESCE(?, building_name),
                       landmark_name = COALESCE(?, landmark_name),
                       micro_market = COALESCE(?, micro_market),
                       broker_name = COALESCE(?, broker_name),
                       broker_phone = COALESCE(?, broker_phone),
                       last_seen = CASE WHEN ? > COALESCE(last_seen, '') THEN ? ELSE last_seen END,
                       latest_raw_message_id = ?,
                       updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                   WHERE id = ?""",
                (
                    summary["intent"], summary["bhk"], summary["price"], summary["price_unit"],
                    summary["area_sqft"], summary["furnishing"], summary["location_label"],
                    summary["building_name"], summary["landmark_name"], summary["micro_market"],
                    summary["broker_name"], summary["broker_phone"], seen_at, seen_at,
                    obs.raw_message_id, listing_id,
                )
            )
        else:
            cur = self.db.execute(
                """INSERT INTO listings
                   (fingerprint, intent, bhk, price, price_unit, area_sqft, furnishing,
                    location_label, building_name, landmark_name, micro_market,
                    broker_name, broker_phone, first_seen, last_seen,
                    observation_count, group_count, latest_raw_message_id,
                    representative_raw_message_id)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (
                    fingerprint, summary["intent"], summary["bhk"], summary["price"],
                    summary["price_unit"], summary["area_sqft"], summary["furnishing"],
                    summary["location_label"], summary["building_name"], summary["landmark_name"],
                    summary["micro_market"], summary["broker_name"], summary["broker_phone"],
                    seen_at, seen_at, 0, 0, obs.raw_message_id, obs.raw_message_id,
                )
            )
            listing_id = cur.lastrowid

        self.db.execute(
            """INSERT OR IGNORE INTO listing_observations
               (listing_id, raw_message_id, parsed_id, group_name, seen_at)
               VALUES (?,?,?,?,?)""",
            (listing_id, obs.raw_message_id, parsed_id or obs.raw_message_id, raw.group_name, seen_at)
        )
        self.db.execute(
            """UPDATE listings SET
                   observation_count = (SELECT COUNT(*) FROM listing_observations WHERE listing_id = ?),
                   group_count = (SELECT COUNT(DISTINCT group_name) FROM listing_observations WHERE listing_id = ?),
                   first_seen = COALESCE(first_seen, ?),
                   last_seen = CASE WHEN ? > COALESCE(last_seen, '') THEN ? ELSE last_seen END,
                   latest_raw_message_id = ?,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
               WHERE id = ?""",
            (listing_id, listing_id, seen_at, seen_at, seen_at, obs.raw_message_id, listing_id)
        )
        if commit:
            self._commit()
        return listing_id

    def rebuild_listings(self):
        self.db.execute("DELETE FROM listing_observations")
        self.db.execute("DELETE FROM listings")
        rows = self.db.execute(
            """SELECT p.*, r.sender as raw_sender, r.group_name as raw_group, r.timestamp as raw_timestamp,
                      r.created_at as raw_created_at
               FROM parsed_output p
               JOIN raw_messages r ON r.id = p.raw_message_id
               ORDER BY p.id ASC"""
        ).fetchall()
        for row in rows:
            data = dict(row)
            if data.get("location") and isinstance(data["location"], str):
                try:
                    data["location"] = json.loads(data["location"])
                except (json.JSONDecodeError, TypeError):
                    pass
            obs = ParsedObservation(
                id=data.get("id", 0),
                raw_message_id=data.get("raw_message_id", 0),
                intent=data.get("intent"),
                principal=data.get("principal"),
                bhk=data.get("bhk"),
                price=data.get("price"),
                price_unit=data.get("price_unit"),
                area_sqft=data.get("area_sqft"),
                furnishing=data.get("furnishing"),
                location_raw=data.get("location_raw"),
                location=json.dumps(data.get("location")) if data.get("location") else None,
                building_name=data.get("building_name"),
                landmark_name=data.get("landmark_name"),
                street_name=data.get("street_name"),
                area=data.get("area"),
                micro_market=data.get("micro_market"),
                developer=data.get("developer"),
                broker_name=data.get("broker_name"),
                broker_phone=data.get("broker_phone"),
                profile_name=data.get("profile_name"),
                forwarded=data.get("forwarded", 0),
                confidence=data.get("confidence", 0.0),
                raw_payload=data.get("raw_payload") or "{}",
                event_id=data.get("event_id"),
                created_at=data.get("created_at", data.get("raw_created_at", "")),
                embedding=data.get("embedding"),
            )
            raw = RawMessage(
                id=data.get("raw_message_id", 0),
                group_name=data.get("raw_group", ""),
                sender=data.get("raw_sender", ""),
                message=data.get("raw_message", ""),
                timestamp=data.get("raw_timestamp", ""),
                created_at=data.get("raw_created_at", ""),
            )
            self.upsert_listing_from_parsed(obs, parsed_id=data.get("id"), commit=False)
        self._commit()

    def get_parsed_by_raw(self, raw_id: int) -> ParsedObservation | None:
        row = self.db.execute(
            "SELECT * FROM parsed_output WHERE raw_message_id = ? ORDER BY id DESC LIMIT 1",
            (raw_id,)
        ).fetchone()
        return dict_to_dataclass(ParsedObservation, row) if row else None

    def get_listings(self, limit: int = 50, offset: int = 0) -> list[dict]:
        rows = self.db.execute(
            """SELECT l.*, r.message as latest_message, r.group_name as latest_group,
                      r.timestamp as latest_timestamp, r.sender as latest_sender
               FROM listings l
               LEFT JOIN raw_messages r ON r.id = l.latest_raw_message_id
               ORDER BY l.last_seen DESC, l.id DESC
               LIMIT ? OFFSET ?""",
            (limit, offset)
        ).fetchall()
        return [dict(r) for r in rows]

    def get_parsed(self, limit: int = 50, offset: int = 0, intent: str = "") -> list[dict]:
        where = ""
        params: list = []
        if intent:
            intents = [s.strip() for s in intent.split(",") if s.strip()]
            if intents:
                placeholders = ",".join("?" * len(intents))
                where = f"WHERE p.intent IN ({placeholders})"
                params = intents
        params.extend([limit, offset])
        rows = self.db.execute(
            f"""SELECT p.id, p.raw_message_id, p.message_type, p.intent, p.principal, p.bhk,
                      p.price, p.price_unit, p.area_sqft, p.furnishing,
                      p.location_raw, p.location, p.building_name, p.landmark_name,
                      p.street_name, p.area, p.micro_market, p.developer,
                      p.broker_name, p.broker_phone, p.profile_name,
                      p.listing_index, p.forwarded, p.confidence, p.raw_payload, p.event_id,
                      p.created_at,
                      r.message as raw_message,
                      r.sender as raw_sender,
                      r.group_name as raw_group,
                      r.timestamp as raw_timestamp
               FROM parsed_output p
               JOIN raw_messages r ON r.id = p.raw_message_id
               {where}
               ORDER BY p.id DESC LIMIT ? OFFSET ?""",
            params
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("location") and isinstance(d["location"], str):
                try:
                    d["location"] = json.loads(d["location"])
                except (json.JSONDecodeError, TypeError):
                    pass
            if d.get("broker_name"):
                d["broker_name"] = _clean_person_name(d["broker_name"])
            elif d.get("raw_sender"):
                d["broker_name"] = _clean_person_name(d["raw_sender"])
            result.append(d)
        return result

    # ── Resolver decisions ─────────────────────────────────────

    def save_resolver_decision(self, dec: ResolverDecision) -> int:
        if not dec.event_id:
            parsed = self.db.execute(
                "SELECT event_id FROM parsed_output WHERE id = ?", (dec.parsed_id,)
            ).fetchone()
            if parsed and parsed["event_id"]:
                dec.event_id = parsed["event_id"]
        cur = self.db.execute(
            """INSERT INTO resolver_decisions
               (parsed_id, building_id, building_name,
                landmark_id, landmark_name, street_id, street_name,
                project_id, project_name, developer_name,
                parser_confidence, resolver_confidence, final_confidence,
                method, method_detail, candidates, failure_category, error,
                event_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (dec.parsed_id, dec.building_id, dec.building_name,
             dec.landmark_id, dec.landmark_name, dec.street_id, dec.street_name,
             dec.project_id, dec.project_name, dec.developer_name,
             dec.parser_confidence, dec.resolver_confidence, dec.final_confidence,
             dec.method, dec.method_detail, dec.candidates,
             dec.failure_category, dec.error, dec.event_id)
        )
        self._commit()
        return cur.lastrowid

    def get_resolver_by_parsed(self, parsed_id: int) -> ResolverDecision | None:
        row = self.db.execute(
            "SELECT * FROM resolver_decisions WHERE parsed_id = ? ORDER BY id DESC LIMIT 1",
            (parsed_id,)
        ).fetchone()
        return dict_to_dataclass(ResolverDecision, row) if row else None

    def get_resolver_decisions(self, limit: int = 50, offset: int = 0,
                               method: str = "") -> list[dict]:
        if method:
            clause = "WHERE rd.method = ?"
            params = [method, limit, offset]
        else:
            clause = ""
            params = [limit, offset]
        rows = self.db.execute(
            f"""SELECT rd.*, p.intent, p.principal, p.broker_name, p.building_name as parsed_building,
                       p.location_raw, p.landmark_name as parsed_landmark,
                       r.message as raw_message
                FROM resolver_decisions rd
                JOIN parsed_output p ON p.id = rd.parsed_id
                JOIN raw_messages r ON p.raw_message_id = r.id
                {clause}
                ORDER BY rd.id DESC LIMIT ? OFFSET ?""",
            params
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("candidates"), str):
                try:
                    d["candidates"] = json.loads(d["candidates"])
                except (json.JSONDecodeError, TypeError):
                    d["candidates"] = []
            result.append(d)
        return result

    def get_failed(self, limit: int = 50, offset: int = 0) -> list[dict]:
        rows = self.db.execute(
            """SELECT rd.*, p.intent, p.principal, p.broker_name, p.location_raw, p.landmark_name,
                      r.message as raw_message, r.sender, r.timestamp
               FROM resolver_decisions rd
               JOIN parsed_output p ON p.id = rd.parsed_id
               JOIN raw_messages r ON p.raw_message_id = r.id
               WHERE rd.method IN ('unresolved', 'error')
               ORDER BY rd.id DESC LIMIT ? OFFSET ?""",
            (limit, offset)
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("candidates"), str):
                try:
                    d["candidates"] = json.loads(d["candidates"])
                except (json.JSONDecodeError, TypeError):
                    d["candidates"] = []
            result.append(d)
        return result

    # ── AI layer (read-only) ───────────────────────────────────

    def get_all_parsed_with_embeddings(self) -> list[dict]:
        rows = self.db.execute(
            "SELECT * FROM parsed_output WHERE embedding IS NOT NULL ORDER BY id DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def knn_search(self, query_embedding: bytes, k: int = 10) -> list[dict]:
        from lab.embedding import unpack_embedding, cosine_similarity
        q_vec = unpack_embedding(query_embedding)
        rows = self.db.execute(
            "SELECT id, embedding, raw_message_id, intent, principal, bhk, price, "
            "price_unit, area_sqft, furnishing, building_name, landmark_name, "
            "micro_market, broker_name, forwarded, confidence, created_at "
            "FROM parsed_output WHERE embedding IS NOT NULL"
        ).fetchall()
        scored = []
        for r in rows:
            d = dict(r)
            emb = d.pop("embedding", None)
            if emb:
                vec = unpack_embedding(emb)
                sim = cosine_similarity(q_vec, vec)
                scored.append((sim, d))
        scored.sort(key=lambda x: -x[0])
        for sim, d in scored[:k]:
            d["similarity"] = round(sim, 4)
        return [d for _, d in scored[:k]]

    def get_observations_by_broker(self, broker_name: str) -> list[dict]:
        rows = self.db.execute(
            """SELECT p.id, p.raw_message_id, p.intent, p.principal, p.bhk,
                      p.price, p.price_unit, p.area_sqft, p.furnishing,
                      p.location_raw, p.location, p.building_name, p.landmark_name,
                      p.street_name, p.area, p.micro_market, p.developer,
                      p.broker_name, p.broker_phone, p.profile_name,
                      p.forwarded, p.confidence, p.raw_payload, p.event_id,
                      p.created_at,
                      r.message as raw_message
               FROM parsed_output p
               JOIN raw_messages r ON r.id = p.raw_message_id
               WHERE p.broker_name = ? ORDER BY p.id DESC""",
            (broker_name,)
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("location") and isinstance(d["location"], str):
                try:
                    d["location"] = json.loads(d["location"])
                except (json.JSONDecodeError, TypeError):
                    pass
            result.append(d)
        return result

    def get_observations_by_building(self, building_name: str) -> list[dict]:
        rows = self.db.execute(
            """SELECT p.id, p.raw_message_id, p.intent, p.principal, p.bhk,
                      p.price, p.price_unit, p.area_sqft, p.furnishing,
                      p.location_raw, p.location, p.building_name, p.landmark_name,
                      p.street_name, p.area, p.micro_market, p.developer,
                      p.broker_name, p.broker_phone, p.profile_name,
                      p.forwarded, p.confidence, p.raw_payload, p.event_id,
                      p.created_at,
                      r.message as raw_message
               FROM parsed_output p
               JOIN raw_messages r ON r.id = p.raw_message_id
               WHERE LOWER(p.building_name) = LOWER(?) ORDER BY p.id DESC""",
            (building_name,)
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            if d.get("location") and isinstance(d["location"], str):
                try:
                    d["location"] = json.loads(d["location"])
                except (json.JSONDecodeError, TypeError):
                    pass
            result.append(d)
        return result

    def get_top_brokers_today(self, today_prefix: str, limit: int = 10) -> list[dict]:
        rows = self.db.execute(
            """SELECT p.broker_name, COUNT(*) as c
               FROM parsed_output p
               JOIN raw_messages r ON r.id = p.raw_message_id
               WHERE r.timestamp LIKE ? AND p.broker_name IS NOT NULL AND p.broker_name != ''
               GROUP BY p.broker_name ORDER BY c DESC LIMIT ?""",
            (f"{today_prefix}%", limit)
        ).fetchall()
        return [dict(r) for r in rows]

    # ── Evaluations ────────────────────────────────────────────

    def save_evaluation(self, ev: Evaluation) -> int:
        if not ev.event_id:
            raw = self.get_raw_message(ev.raw_message_id)
            if raw:
                ev.event_id = raw.event_id
        existing = self.db.execute(
            "SELECT id FROM evaluations WHERE raw_message_id = ?",
            (ev.raw_message_id,)
        ).fetchone()
        if existing:
            cols = [
                "expected_intent", "expected_principal", "expected_bhk", "expected_price",
                "expected_price_unit", "expected_area_sqft", "expected_furnishing",
                "expected_building", "expected_landmark", "expected_street",
                "expected_area", "expected_micro_market", "expected_developer",
                "expected_broker",
                "extracted_intent", "extracted_principal", "extracted_bhk", "extracted_price",
                "extracted_price_unit", "extracted_area_sqft", "extracted_furnishing",
                "extracted_building", "extracted_landmark", "extracted_street",
                "extracted_area", "extracted_micro_market", "extracted_developer",
                "extracted_broker",
                "accuracy_overall", "correction_notes", "evaluated_at",
                "event_id",
            ]
            sets = ", ".join(f"{c} = ?" for c in cols)
            vals = [getattr(ev, c, None) for c in cols] + [ev.raw_message_id]
            self.db.execute(f"UPDATE evaluations SET {sets} WHERE raw_message_id = ?", vals)
            self._commit()
            return existing["id"]
        cur = self.db.execute(
            """INSERT INTO evaluations
               (raw_message_id,
                expected_intent, expected_principal, expected_bhk, expected_price,
                expected_price_unit, expected_area_sqft, expected_furnishing,
                expected_building, expected_landmark, expected_street,
                expected_area, expected_micro_market, expected_developer,
                expected_broker,
                extracted_intent, extracted_principal, extracted_bhk, extracted_price,
                extracted_price_unit, extracted_area_sqft, extracted_furnishing,
                extracted_building, extracted_landmark, extracted_street,
                extracted_area, extracted_micro_market, extracted_developer,
                extracted_broker,
                accuracy_overall, correction_notes, evaluated_at, event_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (ev.raw_message_id,
             ev.expected_intent, ev.expected_principal, ev.expected_bhk, ev.expected_price,
             ev.expected_price_unit, ev.expected_area_sqft, ev.expected_furnishing,
             ev.expected_building, ev.expected_landmark, ev.expected_street,
             ev.expected_area, ev.expected_micro_market, ev.expected_developer,
             ev.expected_broker,
             ev.extracted_intent, ev.extracted_principal, ev.extracted_bhk, ev.extracted_price,
             ev.extracted_price_unit, ev.extracted_area_sqft, ev.extracted_furnishing,
             ev.extracted_building, ev.extracted_landmark, ev.extracted_street,
             ev.extracted_area, ev.extracted_micro_market, ev.extracted_developer,
             ev.extracted_broker,
             ev.accuracy_overall, ev.correction_notes, ev.evaluated_at, ev.event_id)
        )
        self._commit()
        return cur.lastrowid

    def get_evaluation_by_raw(self, raw_id: int) -> Evaluation | None:
        row = self.db.execute(
            "SELECT * FROM evaluations WHERE raw_message_id = ? ORDER BY id DESC LIMIT 1",
            (raw_id,)
        ).fetchone()
        return dict_to_dataclass(Evaluation, row) if row else None

    def get_evaluations(self, limit: int = 50, offset: int = 0) -> list[dict]:
        rows = self.db.execute(
            """SELECT e.*, r.message as raw_message
               FROM evaluations e
               JOIN raw_messages r ON r.id = e.raw_message_id
               ORDER BY e.id DESC LIMIT ? OFFSET ?""",
            (limit, offset)
        ).fetchall()
        return [dict(r) for r in rows]

    # ── AI Suggestions ─────────────────────────────────────────

    def get_suggestions(self, status: str = "pending", limit: int = 50, offset: int = 0) -> list[dict]:
        if status == "all":
            rows = self.db.execute(
                "SELECT * FROM ai_suggestions ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset)
            ).fetchall()
        else:
            rows = self.db.execute(
                "SELECT * FROM ai_suggestions WHERE status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (status, limit, offset)
            ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            for col in ("source_data", "proposal_data"):
                if isinstance(d.get(col), str):
                    try:
                        d[col] = json.loads(d[col])
                    except (json.JSONDecodeError, TypeError):
                        pass
            result.append(d)
        return result

    def get_suggestion_counts(self) -> dict:
        rows = self.db.execute(
            "SELECT status, COUNT(*) as c FROM ai_suggestions GROUP BY status"
        ).fetchall()
        counts = {"pending": 0, "approved": 0, "rejected": 0, "ignored": 0}
        for r in rows:
            counts[r["status"]] = r["c"]
        return counts

    def update_suggestion_status(self, sug_id: int, status: str, rejection_reason: str = ""):
        if rejection_reason:
            self.db.execute(
                "UPDATE ai_suggestions SET status = ?, rejection_reason = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
                (status, rejection_reason, sug_id)
            )
        else:
            self.db.execute(
                "UPDATE ai_suggestions SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
                (status, sug_id)
            )
        self._commit()
        if status == "approved":
            self.apply_suggestion(sug_id)

    def batch_update_suggestions(self, ids: list[int], status: str, rejection_reason: str = ""):
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        now = datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ")
        if rejection_reason:
            self.db.execute(
                f"UPDATE ai_suggestions SET status = ?, rejection_reason = ?, updated_at = ? WHERE id IN ({placeholders})",
                (status, rejection_reason, now, *ids)
            )
        else:
            self.db.execute(
                f"UPDATE ai_suggestions SET status = ?, updated_at = ? WHERE id IN ({placeholders})",
                (status, now, *ids)
            )
        self._commit()
        if status == "approved":
            for sug_id in ids:
                try:
                    self.apply_suggestion(sug_id)
                except Exception:
                    pass

    def get_ai_memory_stats(self) -> dict:
        alias_count = self.db.execute(
            "SELECT COUNT(*) FROM location_aliases"
        ).fetchone()[0]
        building_alias_count = self.db.execute(
            "SELECT COUNT(*) FROM building_aliases"
        ).fetchone()[0]
        broker_alias_count = self.db.execute(
            "SELECT COUNT(*) FROM broker_aliases_global"
        ).fetchone()[0]
        merged_brokers = self.db.execute(
            "SELECT COUNT(*) FROM suggestions_merged_brokers"
        ).fetchone()[0] if self.db.execute(
            "SELECT name FROM sqlite_master WHERE type='table' AND name='suggestions_merged_brokers'"
        ).fetchone() else 0
        buildings_taught = self.db.execute(
            "SELECT COUNT(DISTINCT building_name) FROM resolver_decisions WHERE building_name IS NOT NULL AND method LIKE '%ai%'"
        ).fetchone()[0]
        locations_taught = self.db.execute(
            "SELECT COUNT(DISTINCT micro_market) FROM parsed_output WHERE micro_market IS NOT NULL AND micro_market != ''"
        ).fetchone()[0]
        total_approved = self.db.execute(
            "SELECT COUNT(*) FROM ai_suggestions WHERE status = 'approved'"
        ).fetchone()[0]
        total_rejected = self.db.execute(
            "SELECT COUNT(*) FROM ai_suggestions WHERE status = 'rejected'"
        ).fetchone()[0]
        total_suggestions = self.db.execute(
            "SELECT COUNT(*) FROM ai_suggestions"
        ).fetchone()[0]
        total_ai_calls = self.db.execute(
            "SELECT COUNT(*) FROM ai_usage_log"
        ).fetchone()[0]
        estimated_avoided = alias_count * 3 + building_alias_count * 3 + buildings_taught * 2 + merged_brokers * 5
        return {
            "aliases_learned": alias_count,
            "building_aliases": building_alias_count,
            "broker_aliases": broker_alias_count,
            "brokers_merged": merged_brokers,
            "buildings_discovered": buildings_taught,
            "locations_mapped": locations_taught,
            "total_approved": total_approved,
            "total_rejected": total_rejected,
            "total_suggestions": total_suggestions,
            "total_ai_calls": total_ai_calls,
            "estimated_ai_calls_avoided": estimated_avoided,
        }

    def get_ai_usage_stats(self, days: int = 1) -> dict:
        cutoff = (datetime.utcnow() - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
        row = self.db.execute(
            """SELECT COUNT(*) as calls,
                      COALESCE(SUM(tokens_input), 0) as tokens_in,
                      COALESCE(SUM(tokens_output), 0) as tokens_out,
                      COALESCE(SUM(cost_usd), 0) as cost
               FROM ai_usage_log WHERE created_at >= ?""",
            (cutoff,)
        ).fetchone()
        today_cutoff = datetime.utcnow().strftime("%Y-%m-%dT00:00:00Z")
        today_row = self.db.execute(
            """SELECT COUNT(*) as calls,
                      COALESCE(SUM(tokens_input), 0) as tokens_in,
                      COALESCE(SUM(tokens_output), 0) as tokens_out,
                      COALESCE(SUM(cost_usd), 0) as cost
               FROM ai_usage_log WHERE created_at >= ?""",
            (today_cutoff,)
        ).fetchone()
        return {
            "period_days": days,
            "calls": row[0],
            "tokens_input": row[1],
            "tokens_output": row[2],
            "cost_usd": round(row[3], 6),
            "today_calls": today_row[0],
            "today_tokens_input": today_row[1],
            "today_tokens_output": today_row[2],
            "today_cost_usd": round(today_row[3], 6),
        }

    def create_suggestion(self, sug: AISuggestion) -> int:
        if sug.confidence < 0.80:
            return 0
        sug.status = "approved" if sug.confidence >= 0.95 else "pending"
        cur = self.db.execute(
            """INSERT INTO ai_suggestions
               (agent, suggestion_type, title, description, source_data, proposal_data, confidence, status)
               VALUES (?,?,?,?,?,?,?,?)""",
            (sug.agent, sug.suggestion_type, sug.title, sug.description,
             sug.source_data, sug.proposal_data, sug.confidence, sug.status)
        )
        sug_id = cur.lastrowid
        self._commit()
        if sug.status == "approved":
            self.apply_suggestion(sug_id)
        return sug_id

    def apply_suggestion(self, sug_id: int) -> bool:
        row = self.db.execute("SELECT * FROM ai_suggestions WHERE id = ?", (sug_id,)).fetchone()
        if not row:
            return False
        d = dict(row)
        try:
            proposal = json.loads(d["proposal_data"]) if isinstance(d["proposal_data"], str) else d["proposal_data"]
        except (json.JSONDecodeError, TypeError):
            proposal = {}
        action = proposal.get("action", "")
        ok = False
        if action == "merge_listings":
            keep_id = proposal.get("keep_id")
            merge_id = proposal.get("merge_id")
            if keep_id and merge_id and keep_id != merge_id:
                self.db.execute(
                    "UPDATE listing_observations SET listing_id = ? WHERE listing_id = ?",
                    (keep_id, merge_id)
                )
                self.db.execute("DELETE FROM listings WHERE id = ?", (merge_id,))
                self._commit()
                ok = True
        elif action == "merge_brokers":
            keep_id = proposal.get("keep_id")
            merge_id = proposal.get("merge_id")
            if keep_id and merge_id and keep_id != merge_id:
                for table in ("broker_observations", "broker_phones", "broker_aliases",
                              "broker_market_stats", "broker_building_stats"):
                    self.db.execute(
                        f"UPDATE {table} SET broker_id = ? WHERE broker_id = ?",
                        (keep_id, merge_id)
                    )
                self.db.execute("DELETE FROM brokers WHERE id = ?", (merge_id,))
                self._commit()
                ok = True
        elif action == "create_alias":
            alias = proposal.get("alias", "")
            canonical = proposal.get("canonical", "")
            if alias and canonical:
                try:
                    self.db.execute(
                        "INSERT OR IGNORE INTO location_aliases (alias, canonical, confidence) VALUES (?,?,?)",
                        (alias, canonical, d.get("confidence", 0.85))
                    )
                    self._commit()
                    ok = True
                except Exception:
                    pass
        if ok:
            self.db.execute(
                "UPDATE ai_suggestions SET status = 'approved', updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
                (sug_id,)
            )
            self._commit()
        return ok

    # ── Enrichment jobs ────────────────────────────────────────

    def create_enrichment_job(self, parsed_id: int, raw_message_id: int,
                              scheduled_after: str) -> int:
        cur = self.db.execute(
            """INSERT OR IGNORE INTO enrichment_jobs
               (parsed_id, raw_message_id, scheduled_after)
               VALUES (?,?,?)""",
            (parsed_id, raw_message_id, scheduled_after)
        )
        self._commit()
        return cur.lastrowid

    def get_pending_enrichment_jobs(self, limit: int = 50) -> list[dict]:
        rows = self.db.execute(
            """SELECT * FROM enrichment_jobs
               WHERE status = 'pending'
                 AND scheduled_after <= strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
               ORDER BY scheduled_after ASC
               LIMIT ?""",
            (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def claim_enrichment_job(self, job_id: int) -> bool:
        cur = self.db.execute(
            """UPDATE enrichment_jobs
               SET status = 'running', started_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                   attempts = attempts + 1
               WHERE id = ? AND status = 'pending'""",
            (job_id,)
        )
        self._commit()
        return cur.rowcount > 0

    def complete_enrichment_job(self, job_id: int, error: str = ""):
        if error:
            self.db.execute(
                """UPDATE enrichment_jobs
                   SET status = 'failed', last_error = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                   WHERE id = ?""",
                (error, job_id)
            )
        else:
            self.db.execute(
                """UPDATE enrichment_jobs
                   SET status = 'completed', completed_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                   WHERE id = ?""",
                (job_id,)
            )
        self._commit()

    def get_enrichment_job_by_parsed(self, parsed_id: int) -> dict | None:
        row = self.db.execute(
            "SELECT * FROM enrichment_jobs WHERE parsed_id = ?", (parsed_id,)
        ).fetchone()
        return dict(row) if row else None

    # ── Knowledge graph aliases ─────────────────────────────────

    def create_location_alias(self, alias: str, canonical: str,
                              confidence: float = 0.0, source: str = "ai") -> bool:
        try:
            self.db.execute(
                "INSERT OR IGNORE INTO location_aliases (alias, canonical, confidence, source) VALUES (?,?,?,?)",
                (alias, canonical, confidence, source)
            )
            self._commit()
            return True
        except Exception:
            return False

    def create_building_alias(self, alias: str, canonical: str,
                              confidence: float = 0.0, source: str = "ai") -> bool:
        try:
            self.db.execute(
                "INSERT OR IGNORE INTO building_aliases (alias, canonical, confidence, source) VALUES (?,?,?,?)",
                (alias, canonical, confidence, source)
            )
            self._commit()
            return True
        except Exception:
            return False

    def resolve_location(self, text: str) -> str | None:
        if not text:
            return None
        row = self.db.execute(
            "SELECT canonical FROM location_aliases WHERE alias = ?", (text.strip(),)
        ).fetchone()
        if row:
            return row["canonical"]
        row = self.db.execute(
            "SELECT canonical FROM location_aliases WHERE ? LIKE '%' || alias || '%' ORDER BY LENGTH(alias) DESC LIMIT 1",
            (text.strip(),)
        ).fetchone()
        return row["canonical"] if row else None

    def resolve_building(self, text: str) -> str | None:
        if not text:
            return None
        row = self.db.execute(
            "SELECT canonical FROM building_aliases WHERE alias = ?", (text.strip(),)
        ).fetchone()
        if row:
            return row["canonical"]
        row = self.db.execute(
            "SELECT canonical FROM building_aliases WHERE ? LIKE '%' || alias || '%' ORDER BY LENGTH(alias) DESC LIMIT 1",
            (text.strip(),)
        ).fetchone()
        return row["canonical"] if row else None

    # ── Price stats ────────────────────────────────────────────

    def recompute_price_stats(self):
        self.db.execute("DELETE FROM price_stats")
        rows = self.db.execute(
            """SELECT micro_market, bhk, intent, price
               FROM parsed_output
               WHERE price IS NOT NULL AND price > 0
                 AND micro_market IS NOT NULL AND micro_market != ''
                 AND bhk IS NOT NULL AND bhk != ''"""
        ).fetchall()
        buckets: dict[tuple, list[float]] = {}
        for r in rows:
            key = (r["micro_market"], r["bhk"], r["intent"] or "listing")
            buckets.setdefault(key, []).append(float(r["price"]))
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        for (market, bhk, intent), prices in buckets.items():
            if len(prices) < 3:
                continue
            prices.sort()
            n = len(prices)
            median = prices[n // 2]
            mean = sum(prices) / n
            p5 = prices[int(n * 0.05)]
            p25 = prices[int(n * 0.25)]
            p75 = prices[int(n * 0.75)]
            p95 = prices[int(n * 0.95)]
            self.db.execute(
                """INSERT INTO price_stats
                   (micro_market, bhk, intent, median, mean, p5, p25, p75, p95, count, computed_at)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
                (market, bhk, intent, median, mean, p5, p25, p75, p95, n, now)
            )
        self._commit()

    def get_price_stats(self, micro_market: str, bhk: str,
                        intent: str = "listing") -> dict | None:
        row = self.db.execute(
            "SELECT * FROM price_stats WHERE micro_market = ? AND bhk = ? AND intent = ?",
            (micro_market, bhk, intent)
        ).fetchone()
        return dict(row) if row else None

    # ── Sync jobs ──────────────────────────────────────────────

    def create_sync_job(self, job: SyncJob) -> int:
        cur = self.db.execute(
            """INSERT INTO source_sync_jobs
               (source, instance, group_id, group_name, meta, status)
               VALUES (?,?,?,?,?,?)""",
            (job.source, job.instance, job.group_id, job.group_name,
             job.meta, job.status)
        )
        self._commit()
        return cur.lastrowid

    def update_sync_job(self, job_id: int, **updates):
        sets = ", ".join(f"{k} = ?" for k in updates)
        vals = list(updates.values()) + [job_id]
        self.db.execute(f"UPDATE source_sync_jobs SET {sets} WHERE id = ?", vals)
        self._commit()

    def get_sync_job(self, job_id: int) -> SyncJob | None:
        row = self.db.execute(
            "SELECT * FROM source_sync_jobs WHERE id = ?", (job_id,)
        ).fetchone()
        return dict_to_dataclass(SyncJob, row) if row else None

    def get_sync_jobs(self, limit: int = 200, offset: int = 0,
                      source: str = "", status: str = "") -> list[SyncJob]:
        where = []
        params = []
        if source:
            where.append("source = ?")
            params.append(source)
        if status:
            where.append("status = ?")
            params.append(status)
        clause = ("WHERE " + " AND ".join(where)) if where else ""
        params += [limit, offset]
        rows = self.db.execute(
            f"SELECT * FROM source_sync_jobs {clause} ORDER BY id DESC LIMIT ? OFFSET ?",
            params
        ).fetchall()
        return [dict_to_dataclass(SyncJob, r) for r in rows]

    # ── Sync checkpoints ───────────────────────────────────────

    def get_checkpoints(self, instance_name: str) -> list[SyncCheckpoint]:
        rows = self.db.execute(
            "SELECT * FROM sync_checkpoints WHERE instance_name = ? ORDER BY group_name",
            (instance_name,)
        ).fetchall()
        return [dict_to_dataclass(SyncCheckpoint, r) for r in rows]

    def get_checkpoint(self, instance_name: str,
                       group_jid: str) -> SyncCheckpoint | None:
        row = self.db.execute(
            "SELECT * FROM sync_checkpoints WHERE instance_name = ? AND group_jid = ?",
            (instance_name, group_jid)
        ).fetchone()
        return dict_to_dataclass(SyncCheckpoint, row) if row else None

    def save_checkpoint(self, cp: SyncCheckpoint):
        self.db.execute(
            """INSERT INTO sync_checkpoints
               (instance_name, group_jid, group_name, group_owner, participants,
                last_message_id, last_message_ts, first_message_ts,
                last_synced_ts, total_available, synced_count, status, error)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
               ON CONFLICT(instance_name, group_jid) DO UPDATE SET
                group_name          = COALESCE(excluded.group_name, sync_checkpoints.group_name),
                group_owner         = COALESCE(excluded.group_owner, sync_checkpoints.group_owner),
                participants        = COALESCE(excluded.participants, sync_checkpoints.participants),
                last_message_id     = COALESCE(excluded.last_message_id, sync_checkpoints.last_message_id),
                last_message_ts     = COALESCE(excluded.last_message_ts, sync_checkpoints.last_message_ts),
                first_message_ts    = COALESCE(excluded.first_message_ts, sync_checkpoints.first_message_ts),
                last_synced_ts      = COALESCE(excluded.last_synced_ts, sync_checkpoints.last_synced_ts),
                total_available     = COALESCE(excluded.total_available, sync_checkpoints.total_available),
                synced_count        = COALESCE(excluded.synced_count, sync_checkpoints.synced_count),
                status              = COALESCE(excluded.status, sync_checkpoints.status),
                error               = COALESCE(excluded.error, sync_checkpoints.error)""",
            (cp.instance_name, cp.group_jid, cp.group_name, cp.group_owner,
             cp.participants, cp.last_message_id, cp.last_message_ts,
             cp.first_message_ts, cp.last_synced_ts, cp.total_available,
             cp.synced_count, cp.status, cp.error)
        )
        self._commit()

    # ── Stats ──────────────────────────────────────────────────

    def get_stats(self) -> dict:
        db = self.db
        total_raw = db.execute("SELECT COUNT(*) as c FROM raw_messages").fetchone()["c"]
        total_parsed = db.execute("SELECT COUNT(*) as c FROM parsed_output").fetchone()["c"]
        resolved = db.execute(
            "SELECT COUNT(*) as c FROM resolver_decisions WHERE method = 'resolved'"
        ).fetchone()["c"]
        unresolved = db.execute(
            "SELECT COUNT(*) as c FROM resolver_decisions WHERE method = 'unresolved'"
        ).fetchone()["c"]
        errors = db.execute(
            "SELECT COUNT(*) as c FROM resolver_decisions WHERE method = 'error'"
        ).fetchone()["c"]
        evaluated = db.execute(
            "SELECT COUNT(*) as c FROM evaluations WHERE accuracy_overall IS NOT NULL"
        ).fetchone()["c"]
        avg_row = db.execute(
            "SELECT AVG(accuracy_overall) as a FROM evaluations WHERE accuracy_overall IS NOT NULL"
        ).fetchone()
        avg_accuracy = avg_row["a"] or 0.0
        type_rows = db.execute(
            "SELECT message_type, COUNT(*) as c FROM parsed_output "
            "WHERE message_type IS NOT NULL GROUP BY message_type ORDER BY c DESC"
        ).fetchall()
        failure_rows = db.execute(
            "SELECT failure_category, COUNT(*) as c FROM resolver_decisions "
            "WHERE failure_category IS NOT NULL GROUP BY failure_category ORDER BY c DESC"
        ).fetchall()
        method_rows = db.execute(
            "SELECT method, COUNT(*) as c FROM resolver_decisions GROUP BY method ORDER BY c DESC"
        ).fetchall()
        return {
            "total_raw": total_raw,
            "total_parsed": total_parsed,
            "resolved": resolved,
            "unresolved": unresolved,
            "errors": errors,
            "evaluated": evaluated,
            "avg_accuracy": round(avg_accuracy, 4),
            "message_types": [dict(r) for r in type_rows],
            "failure_categories": [dict(r) for r in failure_rows],
            "methods": [dict(r) for r in method_rows],
        }

    # ── Observation detail ─────────────────────────────────────

    def get_observation_detail(self, obs_id: int) -> dict:
        db = self.db
        raw = db.execute("SELECT * FROM raw_messages WHERE id = ?", (obs_id,)).fetchone()
        raw_dict = dict(raw) if raw else {}

        parsed_rows = db.execute(
            "SELECT * FROM parsed_output WHERE raw_message_id = ? ORDER BY listing_index ASC, id ASC",
            (obs_id,)
        ).fetchall()

        listings = []
        first_parsed = None
        for row in parsed_rows:
            d = dict(row)
            d.pop("embedding", None)
            if d.get("location") and isinstance(d["location"], str):
                try:
                    d["location"] = json.loads(d["location"])
                except (json.JSONDecodeError, TypeError):
                    pass
            listings.append(d)
            if first_parsed is None:
                first_parsed = d

        resolver_dict = {}
        if first_parsed:
            r_row = db.execute(
                "SELECT * FROM resolver_decisions WHERE parsed_id = ? ORDER BY id DESC LIMIT 1",
                (first_parsed["id"],)
            ).fetchone()
            if r_row:
                resolver_dict = dict(r_row)
                if isinstance(resolver_dict.get("candidates"), str):
                    try:
                        resolver_dict["candidates"] = json.loads(resolver_dict["candidates"])
                    except (json.JSONDecodeError, TypeError):
                        resolver_dict["candidates"] = []
        eval_row = db.execute(
            "SELECT * FROM evaluations WHERE raw_message_id = ? ORDER BY id DESC LIMIT 1",
            (obs_id,)
        ).fetchone()
        eval_dict = dict(eval_row) if eval_row else {}
        return {
            "raw": raw_dict,
            "parsed": first_parsed or {},
            "listings": listings,
            "resolver": resolver_dict,
            "evaluation": eval_dict,
        }

    # ── Source summary ─────────────────────────────────────────

    def source_summary(self) -> dict:
        rows = self.db.execute(
            "SELECT source, COUNT(*) as cnt FROM raw_messages GROUP BY source"
        ).fetchall()
        return {r["source"]: r["cnt"] for r in rows}

    # ── Dashboard ──────────────────────────────────────────────

    def dashboard_activity(self, today_prefix: str) -> dict:
        db = self.db
        total = db.execute(
            "SELECT COUNT(*) as c FROM raw_messages WHERE timestamp LIKE ?",
            (f"{today_prefix}%",)
        ).fetchone()["c"]
        return {"messages_today": total}

    def dashboard_message_types_today(self, today_prefix: str) -> list[dict]:
        rows = self.db.execute(
            "SELECT p.intent, COUNT(*) as c FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE r.timestamp LIKE ? AND p.intent IS NOT NULL "
            "GROUP BY p.intent ORDER BY c DESC",
            (f"{today_prefix}%",)
        ).fetchall()
        return [dict(r) for r in rows]

    def dashboard_feed(self, limit: int = 20) -> list[dict]:
        rows = self.db.execute(
            "SELECT r.id, r.message, r.timestamp, r.group_name, r.sender, "
            "p.intent, p.principal, p.broker_name, "
            "p.bhk, p.price, p.price_unit, "
            "p.building_name, p.landmark_name, p.micro_market, p.furnishing, "
            "p.forwarded, p.profile_name, "
            "d.final_confidence, d.method "
            "FROM raw_messages r "
            "LEFT JOIN parsed_output p ON p.raw_message_id = r.id "
            "LEFT JOIN resolver_decisions d ON d.parsed_id = p.id "
            "ORDER BY r.id DESC LIMIT ?",
            (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def dashboard_listings(self, limit: int = 20) -> list[dict]:
        rows = self.db.execute(
            "SELECT r.id, r.message, r.timestamp, r.group_name, r.sender, "
            "p.intent, p.principal, p.broker_name, p.broker_phone, "
            "p.bhk, p.price, p.price_unit, p.area_sqft, p.furnishing, "
            "p.building_name, p.landmark_name, p.street_name, p.area, p.micro_market, p.developer, "
            "p.forwarded, p.profile_name, "
            "d.final_confidence, d.method "
            "FROM raw_messages r "
            "JOIN parsed_output p ON p.raw_message_id = r.id "
            "LEFT JOIN resolver_decisions d ON d.parsed_id = p.id "
            "WHERE p.intent IN ('SELL', 'RENT', 'PRE-LAUNCH', 'COMMERCIAL_SALE', 'COMMERCIAL_RENTAL') "
            "ORDER BY r.id DESC LIMIT ?",
            (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def dashboard_requirements(self, limit: int = 20) -> list[dict]:
        rows = self.db.execute(
            "SELECT r.id, r.message, r.timestamp, r.group_name, r.sender, "
            "p.intent, p.principal, p.broker_name, p.broker_phone, "
            "p.bhk, p.price, p.price_unit, p.furnishing, "
            "p.building_name, p.landmark_name, p.area, p.micro_market, "
            "p.forwarded, p.profile_name, "
            "d.final_confidence, d.method "
            "FROM raw_messages r "
            "JOIN parsed_output p ON p.raw_message_id = r.id "
            "LEFT JOIN resolver_decisions d ON d.parsed_id = p.id "
            "WHERE p.intent IN ('BUY', 'RENTAL_SEEKER') "
            "ORDER BY r.id DESC LIMIT ?",
            (limit,)
        ).fetchall()
        return [dict(r) for r in rows]

    def dashboard_signals(self) -> list[dict]:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        signals = []

        top_buildings = self.db.execute(
            "SELECT p.building_name, COUNT(*) as c FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE r.timestamp LIKE ? AND p.building_name IS NOT NULL AND p.building_name != '' "
            "GROUP BY p.building_name ORDER BY c DESC LIMIT 5",
            (f"{today}%",)
        ).fetchall()
        for b in top_buildings:
            signals.append({"type": "trending_building", "label": b["building_name"], "count": b["c"]})

        top_markets = self.db.execute(
            "SELECT p.micro_market, COUNT(*) as c FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE r.timestamp LIKE ? AND p.micro_market IS NOT NULL AND p.micro_market != '' "
            "GROUP BY p.micro_market ORDER BY c DESC LIMIT 5",
            (f"{today}%",)
        ).fetchall()
        for m in top_markets:
            signals.append({"type": "active_market", "label": m["micro_market"], "count": m["c"]})

        unmatched = self.db.execute(
            "SELECT COUNT(*) as c FROM parsed_output p "
            "JOIN resolver_decisions d ON d.parsed_id = p.id "
            "WHERE p.intent IN ('BUY', 'RENTAL_SEEKER') AND d.method = 'unresolved'"
        ).fetchone()
        if unmatched and unmatched["c"] > 0:
            signals.append({"type": "unmatched_requirements", "count": unmatched["c"]})

        active_brokers = self.db.execute(
            "SELECT p.broker_name, COUNT(*) as c FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE r.timestamp LIKE ? AND p.broker_name IS NOT NULL AND p.broker_name != '' "
            "GROUP BY p.broker_name ORDER BY c DESC LIMIT 5",
            (f"{today}%",)
        ).fetchall()
        for b in active_brokers:
            signals.append({"type": "active_broker", "label": b["broker_name"], "count": b["c"]})

        return signals

    def dashboard_obs_types_today(self, today_prefix: str) -> list[dict]:
        rows = self.db.execute(
            "SELECT p.message_type, COUNT(*) as c FROM parsed_output p "
            "JOIN raw_messages r ON r.id = p.raw_message_id "
            "WHERE r.timestamp LIKE ? AND p.message_type IS NOT NULL "
            "GROUP BY p.message_type ORDER BY c DESC",
            (f"{today_prefix}%",)
        ).fetchall()
        return [dict(r) for r in rows]

    def dashboard_heatmap(self) -> list[dict]:
        rows = self.db.execute(
            "SELECT micro_market, COUNT(*) as c FROM parsed_output "
            "WHERE micro_market IS NOT NULL AND micro_market != '' "
            "GROUP BY micro_market ORDER BY c DESC"
        ).fetchall()
        return [dict(r) for r in rows]

    def dashboard_growth(self, today_prefix: str) -> dict:
        rows = self.db.execute(
            "SELECT DATE(created_at) as day, "
            "building_name, landmark_name, developer "
            "FROM parsed_output "
            "WHERE building_name IS NOT NULL "
            "   OR landmark_name IS NOT NULL "
            "   OR developer IS NOT NULL "
            "ORDER BY created_at"
        ).fetchall()
        daily = {}
        seen_buildings = set()
        seen_landmarks = set()
        seen_developers = set()
        all_buildings = set()
        all_landmarks = set()
        all_developers = set()
        for r in rows:
            day = r["day"]
            if day not in daily:
                daily[day] = {"buildings": set(), "landmarks": set(), "developers": set()}
            b = r["building_name"]
            l = r["landmark_name"]
            d = r["developer"]
            if b:
                daily[day]["buildings"].add(b.lower().strip())
                all_buildings.add(b.lower().strip())
            if l:
                daily[day]["landmarks"].add(l.lower().strip())
                all_landmarks.add(l.lower().strip())
            if d:
                daily[day]["developers"].add(d.lower().strip())
                all_developers.add(d.lower().strip())
        cumulative = {"buildings": 0, "landmarks": 0, "developers": 0}
        timeline = []
        for day in sorted(daily):
            day_data = daily[day]
            new_b = 0
            new_l = 0
            new_d = 0
            today_buildings = set()
            for b in day_data["buildings"]:
                if b not in seen_buildings:
                    new_b += 1
                    seen_buildings.add(b)
                    today_buildings.add(b)
            today_landmarks = set()
            for l in day_data["landmarks"]:
                if l not in seen_landmarks:
                    new_l += 1
                    seen_landmarks.add(l)
                    today_landmarks.add(l)
            today_developers = set()
            for d in day_data["developers"]:
                if d not in seen_developers:
                    new_d += 1
                    seen_developers.add(d)
                    today_developers.add(d)
            cumulative["buildings"] += new_b
            cumulative["landmarks"] += new_l
            cumulative["developers"] += new_d
            timeline.append({
                "day": day,
                "new_buildings": new_b,
                "new_landmarks": new_l,
                "new_developers": new_d,
                "cumulative_buildings": cumulative["buildings"],
                "cumulative_landmarks": cumulative["landmarks"],
                "cumulative_developers": cumulative["developers"],
                "buildings": list(today_buildings),
                "landmarks": list(today_landmarks),
                "developers": list(today_developers),
            })
        return {
            "timeline": timeline,
            "total_buildings": len(all_buildings),
            "total_landmarks": len(all_landmarks),
            "total_developers": len(all_developers),
        }
