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
            "ALTER TABLE raw_messages ADD COLUMN attachments TEXT DEFAULT '[]'",
            "ALTER TABLE raw_messages ADD COLUMN reply_context TEXT DEFAULT '{}'",
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
            "CREATE INDEX IF NOT EXISTS idx_raw_sender_jid ON raw_messages(sender_jid)",
            "CREATE INDEX IF NOT EXISTS idx_raw_sender_phone ON raw_messages(sender_phone)",
            "ALTER TABLE ai_suggestions ADD COLUMN rejection_reason TEXT DEFAULT NULL",
        ]
        for sql in migs:
            try:
                self.db.execute(sql)
            except sqlite3.OperationalError:
                pass
        # Backfill sender identity from raw_payload for existing rows.
        # Historical Baileys MESSAGES_SET events usually store sender id at $.data.sender.id.
        try:
            self.db.execute("""
                UPDATE raw_messages
                SET sender_jid = COALESCE(
                    NULLIF(json_extract(raw_payload, '$.data.key.participant'), ''),
                    NULLIF(json_extract(raw_payload, '$.data.key.participantAlt'), ''),
                    NULLIF(json_extract(raw_payload, '$.data.sender.id'), '')
                )
                WHERE sender_jid IS NULL OR sender_jid = ''
            """)
        except Exception:
            pass
        try:
            self.db.execute("""
                UPDATE raw_messages
                SET sender_phone = COALESCE(
                    NULLIF(json_extract(raw_payload, '$.data.key.participantAlt'), ''),
                    NULLIF(json_extract(raw_payload, '$.data.sender.phone'), '')
                )
                WHERE (sender_phone IS NULL OR sender_phone = '')
            """)
            self.db.execute("""
                UPDATE raw_messages
                SET sender_phone = TRIM(REPLACE(SUBSTR(sender_jid, 1, INSTR(sender_jid, '@') - 1), ' ', ''))
                WHERE sender_jid LIKE '%@s.whatsapp.net'
                  AND (sender_phone IS NULL OR sender_phone = '')
            """)
            self.db.execute("""
                UPDATE raw_messages
                SET sender_phone = ''
                WHERE sender_jid LIKE '%@lid'
                  AND sender_phone = TRIM(REPLACE(SUBSTR(sender_jid, 1, INSTR(sender_jid, '@') - 1), ' ', ''))
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

    @staticmethod
    def _jid_memory_key(sender_jid: str | None = "", sender_phone: str | None = "", sender: str | None = "") -> str:
        jid = (sender_jid or "").strip()
        if jid:
            return f"jid:{jid}"
        digits = re.sub(r"\D+", "", sender_phone or "")
        if len(digits) >= 10:
            return f"phone:{digits[-10:]}"
        name = re.sub(r"\s+", " ", (sender or "").strip().lower())
        return f"name:{name}" if name else "unknown"

    @staticmethod
    def _counter_json(rows, key: str, limit: int = 8) -> str:
        counts: dict[str, int] = defaultdict(int)
        for row in rows:
            value = (row.get(key) if isinstance(row, dict) else row[key]) if key in row.keys() else None
            if value:
                counts[str(value)] += 1
        ordered = sorted(counts.items(), key=lambda item: (-item[1], item[0]))[:limit]
        return json.dumps([{"value": value, "count": count} for value, count in ordered])

    def _refresh_jid_profile(self, jid_key: str):
        profile = self.db.execute(
            "SELECT jid, phone, display_name FROM jid_profiles WHERE jid_key = ?",
            (jid_key,),
        ).fetchone()
        if not profile:
            return
        jid = profile["jid"] or ""
        phone = profile["phone"] or ""
        display_name = profile["display_name"] or ""

        where = ["1=0"]
        params: list = []
        if jid:
            where.append("r.sender_jid = ?")
            params.append(jid)
        if phone:
            where.append("r.sender_phone = ? OR r.sender_phone LIKE ?")
            params.extend([phone, f"%{phone[-10:]}"])
        if display_name:
            where.append("r.sender = ?")
            params.append(display_name)
        where_sql = " OR ".join(f"({clause})" for clause in where)

        raw_rows = [dict(r) for r in self.db.execute(
            f"""SELECT r.id, r.sender, r.sender_jid, r.sender_phone, r.group_name,
                      r.timestamp, r.message_type, r.message
               FROM raw_messages r
               WHERE {where_sql}
               ORDER BY r.timestamp ASC, r.id ASC""",
            params,
        ).fetchall()]
        if not raw_rows:
            return

        parsed_rows = [dict(r) for r in self.db.execute(
            f"""SELECT p.raw_message_id, p.intent, p.bhk, p.price, p.price_unit,
                      p.micro_market, p.location_raw, p.building_name, p.confidence
               FROM parsed_output p
               JOIN raw_messages r ON r.id = p.raw_message_id
               WHERE {where_sql}""",
            params,
        ).fetchall()]

        aliases: dict[str, list[str]] = defaultdict(list)
        for row in raw_rows:
            alias = (row.get("sender") or "").strip()
            if alias:
                aliases[alias].append(row.get("timestamp") or "")

        self.db.execute("DELETE FROM jid_aliases WHERE jid_key = ?", (jid_key,))
        for alias, seen in aliases.items():
            seen_values = [v for v in seen if v]
            self.db.execute(
                """INSERT INTO jid_aliases
                   (jid_key, alias, observation_count, first_seen_at, last_seen_at)
                   VALUES (?,?,?,?,?)""",
                (jid_key, alias, len(seen), min(seen_values) if seen_values else None, max(seen_values) if seen_values else None),
            )

        self.db.execute("DELETE FROM jid_message_index WHERE jid_key = ?", (jid_key,))
        parsed_by_raw: dict[int, list[dict]] = defaultdict(list)
        for row in parsed_rows:
            parsed_by_raw[int(row["raw_message_id"])].append(row)

        listing_count = requirement_count = residential_count = commercial_count = sale_count = rental_count = 0
        for raw in raw_rows:
            parsed_items = parsed_by_raw.get(int(raw["id"]), [])
            if not parsed_items:
                self.db.execute(
                    """INSERT OR IGNORE INTO jid_message_index
                       (jid_key, raw_message_id, group_name, timestamp, message_kind, metadata_json)
                       VALUES (?,?,?,?,?,?)""",
                    (jid_key, raw["id"], raw.get("group_name") or "", raw.get("timestamp"), None, json.dumps({"raw_only": True})),
                )
                continue

            for parsed in parsed_items:
                intent = (parsed.get("intent") or "").upper()
                message_kind = "requirement" if intent in {"BUY", "BUYER", "REQUIREMENT", "RENTAL_SEEKER"} else "listing"
                rc = "commercial" if intent.startswith("COMMERCIAL") else "residential"
                transaction = "rental" if intent in {"RENT", "RENTAL", "RENTAL_SEEKER", "COMMERCIAL_RENTAL"} else "sale"
                listing_count += 1 if message_kind == "listing" else 0
                requirement_count += 1 if message_kind == "requirement" else 0
                commercial_count += 1 if rc == "commercial" else 0
                residential_count += 1 if rc == "residential" else 0
                rental_count += 1 if transaction == "rental" else 0
                sale_count += 1 if transaction == "sale" else 0
                self.db.execute(
                    """INSERT OR IGNORE INTO jid_message_index
                       (jid_key, raw_message_id, group_name, timestamp, message_kind,
                        residential_commercial, transaction_type, bhk, budget, budget_unit,
                        locality, building_name, confidence, metadata_json)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        jid_key,
                        raw["id"],
                        raw.get("group_name") or "",
                        raw.get("timestamp"),
                        message_kind,
                        rc,
                        transaction,
                        parsed.get("bhk"),
                        parsed.get("price"),
                        parsed.get("price_unit"),
                        parsed.get("micro_market") or parsed.get("location_raw"),
                        parsed.get("building_name"),
                        parsed.get("confidence") or 0.0,
                        json.dumps({"intent": intent}),
                    ),
                )

        timestamps = [r.get("timestamp") for r in raw_rows if r.get("timestamp")]
        groups = {r.get("group_name") for r in raw_rows if r.get("group_name")}
        last_raw = raw_rows[-1]
        canonical_alias = max(aliases.items(), key=lambda item: (len(item[1]), len(item[0])))[0] if aliases else display_name
        self.db.execute(
            """UPDATE jid_profiles
               SET display_name = COALESCE(NULLIF(?, ''), display_name),
                   message_count = ?, group_count = ?, listing_count = ?, requirement_count = ?,
                   residential_count = ?, commercial_count = ?, sale_count = ?, rental_count = ?,
                   first_seen_at = ?, last_seen_at = ?, last_message_id = ?,
                   top_localities = ?, top_buildings = ?, top_groups = ?,
                   profile_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
               WHERE jid_key = ?""",
            (
                canonical_alias,
                len(raw_rows),
                len(groups),
                listing_count,
                requirement_count,
                residential_count,
                commercial_count,
                sale_count,
                rental_count,
                min(timestamps) if timestamps else None,
                max(timestamps) if timestamps else None,
                last_raw["id"],
                self._counter_json(parsed_rows, "micro_market"),
                self._counter_json(parsed_rows, "building_name"),
                self._counter_json(raw_rows, "group_name"),
                json.dumps({"source": "raw_messages", "metadata": "derived"}),
                jid_key,
            ),
        )

    def ensure_jid_profile_for_raw(self, msg: RawMessage):
        jid_key = self._jid_memory_key(msg.sender_jid, msg.sender_phone, msg.sender)
        if jid_key == "unknown":
            return
        digits = re.sub(r"\D+", "", msg.sender_phone or "")
        phone = digits[-10:] if len(digits) >= 10 else digits
        self.db.execute(
            """INSERT INTO jid_profiles
               (jid_key, jid, phone, display_name, first_seen_at, last_seen_at, last_message_id)
               VALUES (?,?,?,?,?,?,?)
               ON CONFLICT(jid_key) DO UPDATE SET
                   jid = COALESCE(NULLIF(excluded.jid, ''), jid),
                   phone = COALESCE(NULLIF(excluded.phone, ''), phone),
                   display_name = COALESCE(NULLIF(excluded.display_name, ''), display_name),
                   last_seen_at = excluded.last_seen_at,
                   last_message_id = excluded.last_message_id,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')""",
            (jid_key, msg.sender_jid or "", phone, msg.sender or "", msg.timestamp, msg.timestamp, msg.id),
        )
        self._refresh_jid_profile(jid_key)

    def rebuild_jid_memory(self, limit: int = 0) -> dict:
        self.db.execute("DELETE FROM jid_message_index")
        self.db.execute("DELETE FROM jid_aliases")
        self.db.execute("DELETE FROM jid_profiles")

        raw_rows = [dict(r) for r in self.db.execute(
            """SELECT * FROM raw_messages
               ORDER BY id ASC
               LIMIT CASE WHEN ? > 0 THEN ? ELSE -1 END""",
            (limit, limit),
        ).fetchall()]

        raw_by_id = {int(row["id"]): row for row in raw_rows}
        profiles: dict[str, dict] = {}
        aliases: dict[str, dict[str, list[str]]] = defaultdict(lambda: defaultdict(list))
        raw_keys: dict[int, str] = {}

        for raw in raw_rows:
            key = self._jid_memory_key(raw.get("sender_jid"), raw.get("sender_phone"), raw.get("sender"))
            if key == "unknown":
                continue
            raw_keys[int(raw["id"])] = key
            digits = re.sub(r"\D+", "", raw.get("sender_phone") or "")
            phone = digits[-10:] if len(digits) >= 10 else digits
            profile = profiles.setdefault(key, {
                "jid": raw.get("sender_jid") or "",
                "phone": phone,
                "display_name": raw.get("sender") or "",
                "message_count": 0,
                "groups": set(),
                "first_seen_at": None,
                "last_seen_at": None,
                "last_message_id": None,
                "listing_count": 0,
                "requirement_count": 0,
                "residential_count": 0,
                "commercial_count": 0,
                "sale_count": 0,
                "rental_count": 0,
                "localities": defaultdict(int),
                "buildings": defaultdict(int),
                "group_counts": defaultdict(int),
            })
            if raw.get("sender_jid") and not profile["jid"]:
                profile["jid"] = raw["sender_jid"]
            if phone and not profile["phone"]:
                profile["phone"] = phone
            profile["message_count"] += 1
            if raw.get("group_name"):
                profile["groups"].add(raw["group_name"])
                profile["group_counts"][raw["group_name"]] += 1
            ts = raw.get("timestamp") or raw.get("created_at")
            if ts:
                profile["first_seen_at"] = min(filter(None, [profile["first_seen_at"], ts])) if profile["first_seen_at"] else ts
                if not profile["last_seen_at"] or ts >= profile["last_seen_at"]:
                    profile["last_seen_at"] = ts
                    profile["last_message_id"] = raw["id"]
            alias = (raw.get("sender") or "").strip()
            if alias:
                aliases[key][alias].append(ts or "")

        for key, profile in profiles.items():
            self.db.execute(
                """INSERT INTO jid_profiles (jid_key, jid, phone, display_name)
                   VALUES (?,?,?,?)""",
                (key, profile["jid"], profile["phone"], profile["display_name"]),
            )

        parsed_rows = [dict(r) for r in self.db.execute("""
            SELECT p.raw_message_id, p.intent, p.bhk, p.price, p.price_unit,
                   p.micro_market, p.location_raw, p.building_name, p.confidence,
                   r.group_name, r.timestamp
            FROM parsed_output p
            JOIN raw_messages r ON r.id = p.raw_message_id
            ORDER BY p.raw_message_id ASC, p.listing_index ASC, p.id ASC
        """).fetchall()]

        parsed_by_raw: dict[int, list[dict]] = defaultdict(list)
        for parsed in parsed_rows:
            raw_id = int(parsed["raw_message_id"])
            if raw_id in raw_keys:
                parsed_by_raw[raw_id].append(parsed)

        for raw_id, key in raw_keys.items():
            raw = raw_by_id[raw_id]
            parsed_items = parsed_by_raw.get(raw_id, [])
            if not parsed_items:
                self.db.execute(
                    """INSERT OR IGNORE INTO jid_message_index
                       (jid_key, raw_message_id, group_name, timestamp, message_kind, metadata_json)
                       VALUES (?,?,?,?,?,?)""",
                    (key, raw_id, raw.get("group_name") or "", raw.get("timestamp"), None, json.dumps({"raw_only": True})),
                )
                continue

            profile = profiles[key]
            for parsed in parsed_items:
                intent = (parsed.get("intent") or "").upper()
                message_kind = "requirement" if intent in {"BUY", "BUYER", "REQUIREMENT", "RENTAL_SEEKER"} else "listing"
                rc = "commercial" if intent.startswith("COMMERCIAL") else "residential"
                transaction = "rental" if intent in {"RENT", "RENTAL", "RENTAL_SEEKER", "COMMERCIAL_RENTAL"} else "sale"
                profile["listing_count"] += 1 if message_kind == "listing" else 0
                profile["requirement_count"] += 1 if message_kind == "requirement" else 0
                profile["commercial_count"] += 1 if rc == "commercial" else 0
                profile["residential_count"] += 1 if rc == "residential" else 0
                profile["rental_count"] += 1 if transaction == "rental" else 0
                profile["sale_count"] += 1 if transaction == "sale" else 0
                locality = parsed.get("micro_market") or parsed.get("location_raw")
                building = parsed.get("building_name")
                if locality:
                    profile["localities"][locality] += 1
                if building:
                    profile["buildings"][building] += 1
                self.db.execute(
                    """INSERT OR IGNORE INTO jid_message_index
                       (jid_key, raw_message_id, group_name, timestamp, message_kind,
                        residential_commercial, transaction_type, bhk, budget, budget_unit,
                        locality, building_name, confidence, metadata_json)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (
                        key,
                        raw_id,
                        raw.get("group_name") or "",
                        raw.get("timestamp"),
                        message_kind,
                        rc,
                        transaction,
                        parsed.get("bhk"),
                        parsed.get("price"),
                        parsed.get("price_unit"),
                        locality,
                        building,
                        parsed.get("confidence") or 0.0,
                        json.dumps({"intent": intent}),
                    ),
                )

        def top_json(counter: dict, count: int = 8) -> str:
            ordered = sorted(counter.items(), key=lambda item: (-item[1], item[0]))[:count]
            return json.dumps([{"value": value, "count": total} for value, total in ordered])

        for key, profile in profiles.items():
            alias_counts = aliases.get(key, {})
            if alias_counts:
                profile["display_name"] = max(alias_counts.items(), key=lambda item: (len(item[1]), len(item[0])))[0]
            self.db.execute(
                """UPDATE jid_profiles
                   SET jid = ?, phone = ?, display_name = ?, message_count = ?, group_count = ?,
                       listing_count = ?, requirement_count = ?, residential_count = ?, commercial_count = ?,
                       sale_count = ?, rental_count = ?, first_seen_at = ?, last_seen_at = ?,
                       last_message_id = ?, top_localities = ?, top_buildings = ?, top_groups = ?,
                       profile_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                   WHERE jid_key = ?""",
                (
                    profile["jid"],
                    profile["phone"],
                    profile["display_name"],
                    profile["message_count"],
                    len(profile["groups"]),
                    profile["listing_count"],
                    profile["requirement_count"],
                    profile["residential_count"],
                    profile["commercial_count"],
                    profile["sale_count"],
                    profile["rental_count"],
                    profile["first_seen_at"],
                    profile["last_seen_at"],
                    profile["last_message_id"],
                    top_json(profile["localities"]),
                    top_json(profile["buildings"]),
                    top_json(profile["group_counts"]),
                    json.dumps({"source": "raw_messages", "metadata": "derived"}),
                    key,
                ),
            )
            for alias, seen in alias_counts.items():
                seen_values = [v for v in seen if v]
                self.db.execute(
                    """INSERT INTO jid_aliases
                       (jid_key, alias, observation_count, first_seen_at, last_seen_at)
                       VALUES (?,?,?,?,?)""",
                    (key, alias, len(seen), min(seen_values) if seen_values else None, max(seen_values) if seen_values else None),
                )
        self._commit()
        real_jid_profiles = sum(1 for key in profiles if key.startswith("jid:"))
        fallback_profiles = len(profiles) - real_jid_profiles
        memory_rows = self.db.execute("SELECT COUNT(*) FROM jid_message_index").fetchone()[0]
        return {
            "profiles": len(profiles),
            "real_jid_profiles": real_jid_profiles,
            "fallback_profiles": fallback_profiles,
            "raw_messages": len(raw_rows),
            "indexed_raw_messages": len(raw_keys),
            "memory_rows": memory_rows,
        }

    def search_jid_memory(self, q: str = "", limit: int = 20) -> list[dict]:
        like = f"%{q.strip()}%" if q else "%"
        rows = self.db.execute(
            """SELECT jp.*, GROUP_CONCAT(ja.alias, ' | ') AS aliases
               FROM jid_profiles jp
               LEFT JOIN jid_aliases ja ON ja.jid_key = jp.jid_key
               WHERE jp.display_name LIKE ? OR jp.phone LIKE ? OR jp.jid LIKE ? OR ja.alias LIKE ?
                  OR jp.top_localities LIKE ? OR jp.top_buildings LIKE ?
               GROUP BY jp.id
               ORDER BY jp.message_count DESC, jp.last_seen_at DESC
               LIMIT ?""",
            (like, like, like, like, like, like, limit),
        ).fetchall()
        return [dict(row) for row in rows]

    def get_jid_profile(self, jid_key: str) -> dict | None:
        row = self.db.execute("SELECT * FROM jid_profiles WHERE jid_key = ?", (jid_key,)).fetchone()
        if not row:
            return None
        profile = dict(row)
        profile["aliases"] = [dict(r) for r in self.db.execute(
            "SELECT * FROM jid_aliases WHERE jid_key = ? ORDER BY observation_count DESC",
            (jid_key,),
        ).fetchall()]
        profile["recent_messages"] = [dict(r) for r in self.db.execute(
            """SELECT r.id, r.group_name, r.sender, r.timestamp, r.message, jmi.message_kind,
                      jmi.residential_commercial, jmi.transaction_type, jmi.bhk,
                      jmi.budget, jmi.budget_unit, jmi.locality, jmi.building_name
               FROM jid_message_index jmi
               JOIN raw_messages r ON r.id = jmi.raw_message_id
               WHERE jmi.jid_key = ?
               ORDER BY r.timestamp DESC, r.id DESC
               LIMIT 50""",
            (jid_key,),
        ).fetchall()]
        return profile

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
               (group_name, sender, sender_jid, sender_phone, message, message_type, attachments, reply_context, timestamp, source,
                raw_payload, message_uid, pipeline_version, synced_at, event_id)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (msg.group_name, msg.sender, msg.sender_jid, msg.sender_phone,
             msg.message, msg.message_type, msg.attachments, msg.reply_context,
             msg.timestamp, msg.source, msg.raw_payload, msg.message_uid,
             msg.pipeline_version, msg.synced_at, msg.event_id)
        )
        msg.id = cur.lastrowid
        try:
            self.ensure_jid_profile_for_raw(msg)
        except Exception:
            pass
        self._commit()
        return cur.lastrowid

    def get_raw_message(self, id: int) -> RawMessage | None:
        row = self.db.execute(
            "SELECT * FROM raw_messages WHERE id = ?", (id,)
        ).fetchone()
        return dict_to_dataclass(RawMessage, row) if row else None

    def get_raw_messages(self, limit: int = 50, offset: int = 0,
                         source: str = "", group_name: str = "",
                         sender: str = "", sender_phone: str = "",
                         sender_jid: str = "") -> list[RawMessage]:
        query = "SELECT * FROM raw_messages WHERE 1=1"
        params = []
        if source:
            query += " AND source = ?"
            params.append(source)
        if group_name:
            query += " AND group_name = ?"
            params.append(group_name)
        if sender:
            query += " AND sender = ?"
            params.append(sender)
        if sender_phone:
            query += " AND sender_phone = ?"
            params.append(sender_phone)
        if sender_jid:
            query += " AND sender_jid = ?"
            params.append(sender_jid)
        
        query += " ORDER BY id DESC LIMIT ? OFFSET ?"
        params.extend([limit, offset])
        
        rows = self.db.execute(query, tuple(params)).fetchall()
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
            """SELECT l.*,
                      r.group_name as latest_group,
                      r.timestamp as latest_timestamp
               FROM listings l
               LEFT JOIN raw_messages r ON r.id = l.latest_raw_message_id
               ORDER BY l.last_seen DESC, l.id DESC
               LIMIT ? OFFSET ?""",
            (limit, offset)
        ).fetchall()
        result = []
        for row in rows:
            d = dict(row)
            # Resolve masked phone numbers by broker name lookup
            phone = d.get("broker_phone") or ""
            if "X" in phone or "x" in phone:
                resolved = self._resolve_masked_phone(d.get("broker_name"), d.get("latest_group"))
                if resolved:
                    d["broker_phone"] = resolved
            result.append(d)
        return result

    def get_listing_sources(self, listing_id: int) -> list[dict]:
        """Get source observations that contributed to a listing."""
        # Build group JID → name mapping
        group_map = dict(self.db.execute(
            "SELECT group_id, group_name FROM source_sync_jobs WHERE group_name != ''"
        ).fetchall())

        rows = self.db.execute(
            """SELECT lo.raw_message_id,
                      r.message as raw_message,
                      r.group_name as raw_group,
                      r.sender as raw_sender,
                      r.sender_phone as raw_sender_phone,
                      r.timestamp as raw_timestamp,
                      p.broker_name,
                      p.broker_phone,
                      p.intent,
                      p.principal,
                      p.bhk,
                      p.price,
                      p.price_unit,
                      p.area_sqft,
                      p.furnishing,
                      p.location_raw,
                      p.building_name,
                      p.landmark_name,
                      p.micro_market,
                      p.confidence
               FROM listing_observations lo
               JOIN raw_messages r ON r.id = lo.raw_message_id
               LEFT JOIN parsed_output p ON p.id = lo.parsed_id
               WHERE lo.listing_id = ?
               ORDER BY r.timestamp DESC""",
            (listing_id,)
        ).fetchall()
        result = []
        for r in rows:
            d = dict(r)
            # Resolve group JID to human-readable name
            jid = d.get("raw_group", "")
            d["raw_group_name"] = group_map.get(jid, jid)
            result.append(d)
        return result

    def get_parsed_sources(self, parsed_id: int) -> list[dict]:
        """Get source observations for a parsed output (all observations in the same listing)."""
        # First try: find the listing via listing_observations
        listing_row = self.db.execute(
            "SELECT listing_id FROM listing_observations WHERE parsed_id = ? LIMIT 1",
            (parsed_id,)
        ).fetchone()
        if listing_row:
            return self.get_listing_sources(listing_row["listing_id"])

        # Second try: find the listing by matching the parsed output's fingerprint
        parsed = self.db.execute(
            "SELECT building_name, location_raw, bhk, price, broker_name FROM parsed_output WHERE id = ?",
            (parsed_id,)
        ).fetchone()
        if not parsed:
            return []

        # Try to find a listing that matches key fields
        listing = self.db.execute(
            """SELECT id FROM listings
               WHERE (building_name = ? OR building_name IS NULL)
                 AND (location_label = ? OR location_label IS NULL)
                 AND (bhk = ? OR bhk IS NULL)
                 AND (price = ? OR price IS NULL)
               ORDER BY ABS(COALESCE(price, 0) - COALESCE(?, 0)) ASC
               LIMIT 1""",
            (parsed["building_name"], parsed["location_raw"], parsed["bhk"],
             parsed["price"], parsed["price"])
        ).fetchone()
        if listing:
            return self.get_listing_sources(listing["id"])

        return []

    def _resolve_masked_phone(self, broker_name: str | None, group_name: str | None) -> str | None:
        """Try to resolve a masked phone number from broker/phone tables."""
        if not broker_name:
            return None
        # Try exact broker name match
        row = self.db.execute(
            "SELECT primary_phone FROM brokers WHERE canonical_name = ? AND primary_phone IS NOT NULL AND primary_phone != ''",
            (broker_name,)
        ).fetchone()
        if row and row["primary_phone"] and "X" not in row["primary_phone"]:
            return row["primary_phone"]
        # Try broker_phones via broker_observations
        row = self.db.execute(
            """SELECT bp.phone FROM broker_phones bp
               JOIN brokers b ON b.id = bp.broker_id
               WHERE b.canonical_name = ? AND bp.phone IS NOT NULL AND bp.phone != ''
               ORDER BY bp.observation_count DESC LIMIT 1""",
            (broker_name,)
        ).fetchone()
        if row and row["phone"] and "X" not in row["phone"]:
            return row["phone"]
        return None

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

    # ════════════════════════════════════════════════════════════════════
    # BUILDING ENRICHMENT PIPELINE
    # ════════════════════════════════════════════════════════════════════

    def _generate_building_id(self) -> str:
        """Generate a permanent building ID like BLD-0004127."""
        row = self.db.execute("SELECT MAX(id) FROM buildings").fetchone()
        next_id = (row[0] or 0) + 1
        return f"BLD-{next_id:07d}"

    def create_building(self, canonical_name: str, micro_market: str = None,
                        address: str = None, developer: str = None, **kwargs) -> dict | None:
        """Create a new canonical building entity."""
        existing = self.db.execute(
            "SELECT id, building_id FROM buildings WHERE canonical_name = ?",
            (canonical_name,)
        ).fetchone()
        if existing:
            return {"id": existing["id"], "building_id": existing["building_id"]}

        building_id = self._generate_building_id()
        try:
            self.db.execute("""
                INSERT INTO buildings (building_id, canonical_name, micro_market, address, developer,
                                       pincode, latitude, longitude, google_place_id, status)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'discovered')
            """, (building_id, canonical_name, micro_market, address, developer,
                  kwargs.get("pincode"), kwargs.get("latitude"), kwargs.get("longitude"),
                  kwargs.get("google_place_id")))
            self._commit()
            row = self.db.execute("SELECT id, building_id FROM buildings WHERE building_id = ?",
                                  (building_id,)).fetchone()
            return {"id": row["id"], "building_id": building_id}
        except Exception:
            return None

    def get_building(self, building_id: str = None, building_db_id: int = None,
                     canonical_name: str = None) -> dict | None:
        """Get a building by its permanent ID, database ID, or canonical name."""
        if building_id:
            row = self.db.execute("SELECT * FROM buildings WHERE building_id = ?",
                                  (building_id,)).fetchone()
        elif building_db_id:
            row = self.db.execute("SELECT * FROM buildings WHERE id = ?",
                                  (building_db_id,)).fetchone()
        elif canonical_name:
            row = self.db.execute("SELECT * FROM buildings WHERE canonical_name = ?",
                                  (canonical_name,)).fetchone()
        else:
            return None
        return dict(row) if row else None

    def get_building_aliases(self, building_db_id: int) -> list[dict]:
        """Get all aliases for a building."""
        rows = self.db.execute(
            "SELECT * FROM building_name_aliases WHERE building_id = ? ORDER BY confidence DESC",
            (building_db_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def create_building_alias(self, building_db_id: int, alias: str,
                              canonical_name: str, confidence: float = 0.0,
                              source: str = "whatsapp") -> bool:
        """Create a building alias."""
        try:
            self.db.execute("""
                INSERT OR IGNORE INTO building_name_aliases (building_id, alias, canonical_name, confidence, source)
                VALUES (?, ?, ?, ?, ?)
            """, (building_db_id, alias, canonical_name, confidence, source))
            self._commit()
            return True
        except Exception:
            return False

    def resolve_building_id(self, text: str) -> int | None:
        """Resolve text to a building database ID via aliases."""
        if not text:
            return None
        row = self.db.execute(
            "SELECT building_id FROM building_name_aliases WHERE alias = ?",
            (text.strip(),)
        ).fetchone()
        if row:
            return row["building_id"]
        row = self.db.execute(
            "SELECT building_id FROM building_name_aliases WHERE ? LIKE '%' || alias || '%' ORDER BY LENGTH(alias) DESC LIMIT 1",
            (text.strip(),)
        ).fetchone()
        return row["building_id"] if row else None

    def discover_buildings_from_observations(self, limit: int = 100) -> list[dict]:
        """Extract canonical building names from parsed_output and create building entities."""
        rows = self.db.execute("""
            SELECT building_name, COUNT(*) as obs_count,
                   COUNT(DISTINCT micro_market) as markets,
                   COUNT(DISTINCT broker_name) as brokers
            FROM parsed_output
            WHERE building_name IS NOT NULL AND building_name != ''
            GROUP BY LOWER(building_name)
            HAVING obs_count >= 1
            ORDER BY obs_count DESC
            LIMIT ?
        """, (limit,)).fetchall()

        discovered = []
        for r in rows:
            canonical = r["building_name"]
            existing = self.db.execute(
                "SELECT id, building_id FROM buildings WHERE canonical_name = ?",
                (canonical,)
            ).fetchone()
            if existing:
                discovered.append({"id": existing["id"], "building_id": existing["building_id"],
                                   "canonical_name": canonical, "already_existed": True})
                continue

            result = self.create_building(canonical_name=canonical)
            if result:
                discovered.append({**result, "canonical_name": canonical, "already_existed": False})
                self.create_building_alias(
                    result["id"], canonical, canonical, confidence=1.0, source="whatsapp"
                )
        return discovered

    def create_building_enrichment_job(self, building_db_id: int, provider: str,
                                       priority: int = 0) -> bool:
        """Create an enrichment job for a building."""
        try:
            self.db.execute("""
                INSERT INTO building_enrichment_jobs (building_id, provider, priority, status)
                VALUES (?, ?, ?, 'pending')
            """, (building_db_id, provider, priority))
            self._commit()
            return True
        except Exception:
            return False

    def get_pending_building_jobs(self, limit: int = 10) -> list[dict]:
        """Get pending building enrichment jobs."""
        rows = self.db.execute("""
            SELECT j.*, b.building_id as building_code, b.canonical_name
            FROM building_enrichment_jobs j
            JOIN buildings b ON b.id = j.building_id
            WHERE j.status = 'pending' AND j.scheduled_after <= datetime('now')
            ORDER BY j.priority DESC, j.created_at ASC
            LIMIT ?
        """, (limit,)).fetchall()
        return [dict(r) for r in rows]

    def claim_building_job(self, job_id: int) -> bool:
        """Mark a job as running."""
        try:
            self.db.execute("""
                UPDATE building_enrichment_jobs
                SET status = 'running', started_at = datetime('now'), attempts = attempts + 1
                WHERE id = ? AND status = 'pending'
            """, (job_id,))
            self._commit()
            return self.db.total_changes > 0
        except Exception:
            return False

    def complete_building_job(self, job_id: int, success: bool, error: str = None) -> bool:
        """Mark a job as completed or failed."""
        try:
            status = "completed" if success else "failed"
            self.db.execute("""
                UPDATE building_enrichment_jobs
                SET status = ?, completed_at = datetime('now'), last_error = ?
                WHERE id = ?
            """, (status, error, job_id))
            self._commit()
            return True
        except Exception:
            return False

    def save_enrichment_source(self, building_db_id: int, provider: str,
                               field_name: str, field_value: str,
                               confidence: float = 0.0, source_url: str = None,
                               source_record_id: str = None) -> bool:
        """Save an enrichment source record."""
        try:
            self.db.execute("""
                INSERT OR REPLACE INTO building_enrichment_sources
                    (building_id, provider, field_name, field_value, confidence, source_url, source_record_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (building_db_id, provider, field_name, field_value, confidence, source_url, source_record_id))
            self._commit()
            return True
        except Exception:
            return False

    def update_building_from_enrichment(self, building_db_id: int, fields: dict,
                                        provider: str, confidence: float = 0.0) -> bool:
        """Update building fields from enrichment data."""
        allowed_fields = {"micro_market", "address", "developer", "pincode", "latitude",
                          "longitude", "google_place_id", "cts_number", "survey_number",
                          "building_age", "nearby_metro", "nearby_landmarks",
                          "nearby_roads", "nearby_buildings"}
        updates = {k: v for k, v in fields.items() if k in allowed_fields and v is not None}
        if not updates:
            return False
        set_clause = ", ".join(f"{k} = ?" for k in updates)
        values = list(updates.values()) + [building_db_id]
        try:
            self.db.execute(f"""
                UPDATE buildings SET {set_clause}, updated_at = datetime('now')
                WHERE id = ?
            """, values)
            for field_name, field_value in updates.items():
                self.save_enrichment_source(building_db_id, provider, field_name,
                                           str(field_value), confidence)
            self._commit()
            return True
        except Exception:
            return False

    def add_enrichment_history(self, building_db_id: int, provider: str,
                               action: str, fields_updated: list[str] = None,
                               confidence: float = 0.0, details: dict = None,
                               job_id: int = None) -> bool:
        """Add an enrichment history record."""
        try:
            self.db.execute("""
                INSERT INTO building_enrichment_history
                    (building_id, job_id, provider, action, fields_updated, confidence, details)
                VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (building_db_id, job_id, provider, action,
                  json.dumps(fields_updated or []), confidence, json.dumps(details or {})))
            self._commit()
            return True
        except Exception:
            return False

    def get_building_enrichment_stats(self) -> dict:
        """Get building enrichment dashboard stats."""
        total = self.db.execute("SELECT COUNT(*) FROM buildings").fetchone()[0]
        enriched = self.db.execute(
            "SELECT COUNT(*) FROM buildings WHERE status = 'enriched'"
        ).fetchone()[0]
        pending = self.db.execute(
            "SELECT COUNT(*) FROM building_enrichment_jobs WHERE status = 'pending'"
        ).fetchone()[0]
        failed = self.db.execute(
            "SELECT COUNT(*) FROM building_enrichment_jobs WHERE status = 'failed'"
        ).fetchone()[0]
        avg_confidence = self.db.execute(
            "SELECT AVG(enrichment_confidence) FROM buildings WHERE enrichment_confidence > 0"
        ).fetchone()[0] or 0
        last_run = self.db.execute(
            "SELECT MAX(completed_at) FROM building_enrichment_jobs WHERE status = 'completed'"
        ).fetchone()[0]
        return {
            "total_buildings": total,
            "buildings_enriched": enriched,
            "pending_queue": pending,
            "failed_jobs": failed,
            "avg_confidence": round(avg_confidence * 100, 1),
            "last_run": last_run,
        }

    def save_igr_results(self, building_db_id: int, results: list[dict], district: str, village: str, property_no: str) -> int:
        """Save IGR search results as enrichment history. Returns number of records saved."""
        count = 0
        for r in results:
            try:
                self.add_enrichment_history(
                    building_db_id=building_db_id,
                    provider="igr",
                    action="property_registration",
                    fields_updated=["registrations"],
                    confidence=0.9,
                    details={
                        "district": district,
                        "village": village,
                        "property_no": property_no,
                        "index_no": r.get("index_no", ""),
                        "document_type": r.get("document_type", ""),
                        "registration_date": r.get("registration_date", ""),
                        "deed_date": r.get("deed_date", ""),
                        "property_description": r.get("property_description", ""),
                        "consideration_amount": r.get("consideration_amount", ""),
                        "stamp_duty_paid": r.get("stamp_duty_paid", ""),
                        "sro": r.get("sro", ""),
                    },
                )
                count += 1
            except Exception:
                continue
        return count

    def get_building_profile(self, building_db_id: int) -> dict:
        """Get full building profile with stats."""
        building = self.get_building(building_db_id=building_db_id)
        if not building:
            return None

        aliases = self.get_building_aliases(building_db_id)
        sources = self.db.execute("""
            SELECT * FROM building_enrichment_sources WHERE building_id = ?
            ORDER BY enriched_at DESC
        """, (building_db_id,)).fetchall()
        history = self.db.execute("""
            SELECT * FROM building_enrichment_history WHERE building_id = ?
            ORDER BY created_at DESC LIMIT 50
        """, (building_db_id,)).fetchall()

        listings = self.db.execute("""
            SELECT COUNT(*) FROM listings WHERE building_name = ?
        """, (building["canonical_name"],)).fetchone()[0]
        brokers = self.db.execute("""
            SELECT COUNT(DISTINCT broker_name) FROM parsed_output
            WHERE building_name = ? AND broker_name IS NOT NULL AND broker_name != ''
        """, (building["canonical_name"],)).fetchone()[0]
        requirements = self.db.execute("""
            SELECT COUNT(*) FROM parsed_output
            WHERE building_name = ? AND intent IN ('BUY', 'RENTAL_SEEKER')
        """, (building["canonical_name"],)).fetchone()[0]

        return {
            **building,
            "aliases": aliases,
            "sources": [dict(s) for s in sources],
            "history": [dict(h) for h in history],
            "observed_listings": listings,
            "observed_brokers": brokers,
            "observed_requirements": requirements,
        }

    def refresh_building_counts(self):
        """Recalculate observed_listings, observed_brokers, observed_requirements for all buildings."""
        # Reset all counts
        self.db.execute("UPDATE buildings SET observed_listings=0, observed_brokers=0, observed_requirements=0")

        # Build name → db id mapping
        bld_map = dict(self.db.execute("SELECT canonical_name, id FROM buildings").fetchall())

        # Count listings per building_name from listings table
        listing_counts = {}
        for row in self.db.execute(
            'SELECT building_name, COUNT(*) FROM listings WHERE building_name IS NOT NULL AND building_name != "" GROUP BY building_name'
        ):
            listing_counts[row[0]] = row[1]

        # Count brokers per building_name from parsed_output
        broker_counts = {}
        for row in self.db.execute(
            'SELECT building_name, COUNT(DISTINCT broker_name) FROM parsed_output WHERE building_name IS NOT NULL AND building_name != "" AND broker_name IS NOT NULL AND broker_name != "" GROUP BY building_name'
        ):
            broker_counts[row[0]] = row[1]

        # Count requirements per building_name
        req_counts = {}
        for row in self.db.execute(
            'SELECT building_name, COUNT(*) FROM parsed_output WHERE building_name IS NOT NULL AND building_name != "" AND intent IN ("BUY", "RENTAL_SEEKER") GROUP BY building_name'
        ):
            req_counts[row[0]] = row[1]

        # Update buildings with non-zero counts
        updated = 0
        for name, db_id in bld_map.items():
            l = listing_counts.get(name, 0)
            b = broker_counts.get(name, 0)
            r = req_counts.get(name, 0)
            if l > 0 or b > 0 or r > 0:
                self.db.execute(
                    "UPDATE buildings SET observed_listings=?, observed_brokers=?, observed_requirements=?, updated_at=strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id=?",
                    (l, b, r, db_id)
                )
                updated += 1

        self._commit()
        return updated

    # ─────────────────────────────────────────────
    # REQUIREMENT-LISTING MATCHER
    # ─────────────────────────────────────────────

    def match_requirements(self, requirement_ids: list[int] | None = None, limit_per_req: int = 20) -> int:
        """Match requirements to listings. Returns total matches created.
        
        Dual-mode matching:
        - Residential (SELL/RENT): match on BHK + market + price
        - Commercial: match on area_sqft + market + price
        """
        # Get requirements to match
        if requirement_ids:
            placeholders = ",".join("?" * len(requirement_ids))
            reqs = self.db.execute(f"""
                SELECT id, intent, bhk, price, price_unit, area_sqft, furnishing,
                       building_name, micro_market, broker_name
                FROM parsed_output WHERE id IN ({placeholders})
            """, requirement_ids).fetchall()
        else:
            reqs = self.db.execute("""
                SELECT id, intent, bhk, price, price_unit, area_sqft, furnishing,
                       building_name, micro_market, broker_name
                FROM parsed_output
                WHERE intent IN ('BUY','BUYER','RENTAL_SEEKER')
                AND (bhk IS NOT NULL OR area_sqft IS NOT NULL)
            """).fetchall()

        # Get all listings
        listings = self.db.execute("""
            SELECT id, intent, bhk, price, price_unit, area_sqft, furnishing,
                   building_name, micro_market, broker_name
            FROM listings
            WHERE intent IN ('SELL','RENT','COMMERCIAL')
        """).fetchall()

        # Clear existing matches for these requirements
        if requirement_ids:
            placeholders = ",".join("?" * len(requirement_ids))
            self.db.execute(f"DELETE FROM requirement_matches WHERE requirement_id IN ({placeholders})", requirement_ids)
        else:
            self.db.execute("DELETE FROM requirement_matches")

        total_matches = 0
        for req in reqs:
            req_id, req_intent, req_bhk, req_price, req_price_unit, req_area, req_furn, req_bldg, req_market, req_broker = req
            matches = []

            for lst in listings:
                lst_id, lst_intent, lst_bhk, lst_price, lst_price_unit, lst_area, lst_furn, lst_bldg, lst_market, lst_broker = lst

                # ── Intent filter ──
                is_residential_req = req_intent in ('BUY', 'BUYER', 'RENTAL_SEEKER')
                is_commercial_req = req_intent == 'COMMERCIAL' and req_area and req_area > 0

                if is_residential_req:
                    # SELL listings match BUY requirements, RENT listings match RENTAL_SEEKER
                    if req_intent in ('BUY', 'BUYER') and lst_intent != 'SELL':
                        continue
                    if req_intent == 'RENTAL_SEEKER' and lst_intent != 'RENT':
                        continue
                elif is_commercial_req:
                    if lst_intent != 'COMMERCIAL':
                        continue
                else:
                    continue

                # ── Compute match scores ──
                bhk_score = 0.0
                market_score = 0.0
                price_score = 0.0
                building_score = 0.0
                area_score = 0.0

                if is_residential_req:
                    # BHK match
                    if req_bhk and lst_bhk:
                        req_bhk_num = _parse_bhk(req_bhk)
                        lst_bhk_num = _parse_bhk(lst_bhk)
                        if req_bhk_num and lst_bhk_num:
                            if req_bhk_num == lst_bhk_num:
                                bhk_score = 1.0
                            elif abs(req_bhk_num - lst_bhk_num) == 1:
                                bhk_score = 0.5
                            else:
                                bhk_score = 0.0
                        elif req_bhk == lst_bhk:
                            bhk_score = 1.0
                    elif not req_bhk:
                        bhk_score = 1.0  # No BHK requirement = any BHK matches

                    # Must have BHK match for residential
                    if bhk_score == 0:
                        continue

                elif is_commercial_req:
                    # Area match for commercial
                    if req_area and lst_area and req_area > 0 and lst_area > 0:
                        ratio = min(req_area, lst_area) / max(req_area, lst_area)
                        if ratio >= 0.7:
                            area_score = ratio
                        else:
                            continue  # Too different
                    elif not req_area:
                        area_score = 1.0
                    else:
                        area_score = 0.5  # One has area, other doesn't

                # Market match
                if req_market and lst_market:
                    if req_market.lower() == lst_market.lower():
                        market_score = 1.0
                    else:
                        market_score = 0.0
                        # Allow adjacent markets (skip for now, require exact match)
                        continue
                elif not req_market:
                    market_score = 1.0
                else:
                    market_score = 0.5

                # Must have market match
                if market_score == 0:
                    continue

                # Price match
                if req_price and lst_price and req_price > 0 and lst_price > 0:
                    req_normalized = _normalize_price(req_price, req_price_unit)
                    lst_normalized = _normalize_price(lst_price, lst_price_unit)
                    if req_normalized and lst_normalized:
                        ratio = min(req_normalized, lst_normalized) / max(req_normalized, lst_normalized)
                        if ratio >= 0.5:
                            price_score = ratio
                        else:
                            continue  # Price too far apart
                    else:
                        price_score = 0.5
                elif not req_price or not lst_price:
                    price_score = 1.0
                else:
                    price_score = 0.5

                # Building match
                if req_bldg and lst_bldg:
                    if req_bldg.lower() == lst_bldg.lower():
                        building_score = 1.0
                    else:
                        building_score = 0.0
                else:
                    building_score = 0.5  # Neutral if no building specified

                # ── Compute weighted score ──
                if is_residential_req:
                    # Weights: BHK 30%, Market 25%, Price 25%, Building 10%, Furnishing 10%
                    furn_score = 1.0
                    if req_furn and lst_furn:
                        furn_score = 1.0 if req_furn.lower() == lst_furn.lower() else 0.5
                    score = (bhk_score * 30 + market_score * 25 + price_score * 25 +
                             building_score * 10 + furn_score * 10)
                else:
                    # Commercial: Area 30%, Market 25%, Price 25%, Building 10%, Furnishing 10%
                    furn_score = 1.0
                    if req_furn and lst_furn:
                        furn_score = 1.0 if req_furn.lower() == lst_furn.lower() else 0.5
                    score = (area_score * 30 + market_score * 25 + price_score * 25 +
                             building_score * 10 + furn_score * 10)

                if score > 0:
                    matches.append((
                        req_id, lst_id, round(score, 1),
                        bhk_score if is_residential_req else area_score,
                        market_score, price_score, building_score,
                        1  # intent_match = 1 (already filtered)
                    ))

            # Sort by score descending, take top N
            matches.sort(key=lambda x: x[2], reverse=True)
            for m in matches[:limit_per_req]:
                self.db.execute("""
                    INSERT OR REPLACE INTO requirement_matches
                    (requirement_id, listing_id, match_score, bhk_match, market_match,
                     price_match, building_match, intent_match)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                """, m)
                total_matches += 1

        self._commit()
        return total_matches

    def get_requirement_matches(self, requirement_id: int, limit: int = 20) -> list[dict]:
        """Get matching listings for a requirement, ranked by score."""
        rows = self.db.execute("""
            SELECT rm.listing_id, rm.match_score, rm.bhk_match, rm.market_match,
                   rm.price_match, rm.building_match,
                   l.intent, l.bhk, l.price, l.price_unit, l.area_sqft,
                   l.furnishing, l.building_name, l.micro_market,
                   l.broker_name, l.broker_phone, l.observation_count, l.group_count,
                   l.first_seen, l.last_seen
            FROM requirement_matches rm
            JOIN listings l ON rm.listing_id = l.id
            WHERE rm.requirement_id = ?
            ORDER BY rm.match_score DESC
            LIMIT ?
        """, (requirement_id, limit)).fetchall()

        return [{
            "listing_id": r[0], "match_score": r[1], "bhk_match": r[2],
            "market_match": r[3], "price_match": r[4], "building_match": r[5],
            "listing": {
                "id": r[0], "intent": r[6], "bhk": r[7], "price": r[8],
                "price_unit": r[9], "area_sqft": r[10], "furnishing": r[11],
                "building_name": r[12], "micro_market": r[13],
                "broker_name": r[14], "broker_phone": r[15],
                "observation_count": r[16], "group_count": r[17],
                "first_seen": r[18], "last_seen": r[19],
            }
        } for r in rows]

    def get_match_summary(self, intent: str = "") -> list[dict]:
        """Get match counts for all requirements (for table display)."""
        where = ""
        params: list = []
        if intent:
            where = "WHERE p.intent IN ({})".format(",".join("?" * len(intent.split(","))))
            params = intent.split(",")

        rows = self.db.execute(f"""
            SELECT p.id, COUNT(rm.listing_id) as match_count,
                   COALESCE(MAX(rm.match_score), 0) as best_score
            FROM parsed_output p
            LEFT JOIN requirement_matches rm ON p.id = rm.requirement_id
            {where}
            GROUP BY p.id
        """, params).fetchall()

        return [{"requirement_id": r[0], "match_count": r[1], "best_score": r[2]} for r in rows]

    # ─────────────────────────────────────────────
    # BUILDING ALIAS ENGINE
    # ─────────────────────────────────────────────

    def discover_alias_candidates(self, min_confidence: float = 0.7) -> list[dict]:
        """
        Discover building alias candidates using fuzzy matching and co-occurrence.
        Returns list of suggestions to review.
        """
        from agents.building_alias_engine import (
            fuzzy_score, find_aliases_by_broker, find_aliases_by_cooccurrence,
            generate_merge_suggestions
        )

        # Get all building names with their context
        rows = self.db.execute("""
            SELECT po.building_name, po.broker_name, po.micro_market, po.bhk, po.price
            FROM parsed_output po
            WHERE po.building_name IS NOT NULL AND po.building_name != ''
        """).fetchall()

        messages = [
            {"building_name": r[0], "broker_name": r[1], "micro_market": r[2], "bhk": r[3], "price": r[4]}
            for r in rows
        ]

        # Find candidates using different methods
        broker_candidates = find_aliases_by_broker(messages, threshold=0.65)
        cooccurrence_candidates = find_aliases_by_cooccurrence(messages, threshold=0.6)

        # Combine and deduplicate
        all_candidates = broker_candidates + cooccurrence_candidates
        seen = set()
        unique = []
        for c in all_candidates:
            key = tuple(sorted([c["name1"], c["name2"]]))
            if key not in seen:
                seen.add(key)
                unique.append(c)

        # Generate merge suggestions
        suggestions = generate_merge_suggestions(unique, min_confidence=min_confidence)

        # Filter out already reviewed suggestions
        existing = self.db.execute("SELECT canonical, alias FROM alias_suggestions").fetchall()
        existing_pairs = set((r[0], r[1]) for r in existing)
        existing_pairs.update((r[1], r[0]) for r in existing)  # Both directions

        new_suggestions = [
            s for s in suggestions
            if (s["canonical"], s["alias"]) not in existing_pairs
        ]

        return new_suggestions

    def save_alias_suggestions(self, suggestions: list[dict]) -> int:
        """Save alias suggestions to database. Returns count saved."""
        count = 0
        for s in suggestions:
            try:
                import json
                self.db.execute("""
                    INSERT OR IGNORE INTO alias_suggestions (canonical, alias, confidence, reasons, source)
                    VALUES (?, ?, ?, ?, ?)
                """, (s["canonical"], s["alias"], s["confidence"], json.dumps(s.get("reasons", [])), s.get("source", "auto_discovered")))
                count += 1
            except Exception:
                pass
        self._commit()
        return count

    def get_alias_suggestions(self, status: str = "pending", limit: int = 50) -> list[dict]:
        """Get alias suggestions for review."""
        import json
        rows = self.db.execute("""
            SELECT id, canonical, alias, confidence, reasons, source, status, created_at
            FROM alias_suggestions
            WHERE status = ?
            ORDER BY confidence DESC
            LIMIT ?
        """, (status, limit)).fetchall()

        return [{
            "id": r[0], "canonical": r[1], "alias": r[2], "confidence": r[3],
            "reasons": json.loads(r[4]) if r[4] else [], "source": r[5],
            "status": r[6], "created_at": r[7],
        } for r in rows]

    def review_alias_suggestion(self, suggestion_id: int, approved: bool) -> bool:
        """Approve or reject an alias suggestion."""
        import json
        from datetime import datetime

        row = self.db.execute(
            "SELECT canonical, alias FROM alias_suggestions WHERE id = ?",
            (suggestion_id,)
        ).fetchone()

        if not row:
            return False

        canonical, alias = row
        status = "approved" if approved else "rejected"

        self.db.execute("""
            UPDATE alias_suggestions SET status = ?, reviewed_at = ?
            WHERE id = ?
        """, (status, datetime.utcnow().strftime("%Y-%m-%dT%H:%M:%SZ"), suggestion_id))

        # If approved, add to building_name_aliases
        if approved:
            # Find or create building
            building = self.db.execute(
                "SELECT id FROM buildings WHERE canonical_name = ?",
                (canonical,)
            ).fetchone()

            if building:
                building_id = building[0]
                # Check if alias already exists
                existing = self.db.execute(
                    "SELECT id FROM building_name_aliases WHERE building_id = ? AND alias = ?",
                    (building_id, alias.lower())
                ).fetchone()

                if not existing:
                    self.db.execute("""
                        INSERT INTO building_name_aliases (building_id, alias, canonical_name, confidence, source)
                        VALUES (?, ?, ?, ?, 'alias_engine')
                    """, (building_id, alias.lower(), canonical, 0.9))

                    # Update building alias count
                    self.db.execute("""
                        UPDATE buildings SET updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                        WHERE id = ?
                    """, (building_id,))

        self._commit()
        return True

    def normalize_building_name(self, name: str) -> str:
        """
        Normalize a building name using learned aliases.
        Returns the canonical name if an alias is found, otherwise the original name.
        """
        if not name:
            return name

        # Check if this name is an alias
        row = self.db.execute("""
            SELECT canonical_name FROM building_name_aliases
            WHERE alias = ? OR canonical_name = ?
            LIMIT 1
        """, (name.lower(), name.lower())).fetchone()

        if row:
            return row[0]

        return name

    def get_alias_stats(self) -> dict:
        """Get alias engine statistics."""
        total = self.db.execute("SELECT COUNT(*) FROM alias_suggestions").fetchone()[0]
        pending = self.db.execute("SELECT COUNT(*) FROM alias_suggestions WHERE status = 'pending'").fetchone()[0]
        approved = self.db.execute("SELECT COUNT(*) FROM alias_suggestions WHERE status = 'approved'").fetchone()[0]
        rejected = self.db.execute("SELECT COUNT(*) FROM alias_suggestions WHERE status = 'rejected'").fetchone()[0]
        aliases_in_kb = self.db.execute("SELECT COUNT(*) FROM building_name_aliases").fetchone()[0]

        return {
            "total_suggestions": total,
            "pending": pending,
            "approved": approved,
            "rejected": rejected,
            "aliases_in_kb": aliases_in_kb,
        }

    # ─────────────────────────────────────────────
    # PER-USER KNOWLEDGE EXTRACTION
    # ─────────────────────────────────────────────

    def get_sender_profile(self, sender: str) -> dict:
        """Build a sender profile directly from raw_messages."""
        import re

        # Get all messages from this sender
        rows = self.db.execute("""
            SELECT id, message, group_name, timestamp
            FROM raw_messages
            WHERE sender = ?
            ORDER BY timestamp DESC
        """, (sender,)).fetchall()

        if not rows:
            return {"sender": sender, "message_count": 0}

        # Extract knowledge from messages
        buildings = set()
        bhk_configs = set()
        markets = set()
        groups = set()
        price_patterns = []

        # Common building name patterns
        building_pattern = re.compile(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+(?:Bil|Bldg|Building|Apt|Complex|Tower|Heights|Park|Residency|Enclave|Villa|Society)\b', re.IGNORECASE)

        # BHK pattern
        bhk_pattern = re.compile(r'(\d+)\s*(?:BHK|bhk|Bhk|RK|rk)', re.IGNORECASE)

        # Price pattern
        price_pattern = re.compile(r'(\d+(?:\.\d+)?)\s*(Cr|cr|CRORE|Lac|lac|LAKH|K|k)', re.IGNORECASE)

        # Market patterns (common Mumbai localities)
        market_keywords = {
            'Bandra', 'Andheri', 'Santacruz', 'Khar', 'Juhu', 'Goregaon',
            'Malad', 'Worli', 'Powai', 'BKC', 'Lokhandwala', 'Versova',
            'Dadar', 'Lower Parel', 'Navi Mumbai', 'Thane', 'Kandivali',
            'Borivali', 'Vile Parle', 'Andheri West', 'Bandra West',
        }

        for row in rows:
            msg = row[1] or ""
            groups.add(row[2])

            # Extract buildings
            for match in building_pattern.finditer(msg):
                buildings.add(match.group(1))

            # Extract BHK
            for match in bhk_pattern.finditer(msg):
                bhk_configs.add(f"{match.group(1)} BHK")

            # Extract prices
            for match in price_pattern.finditer(msg):
                price_patterns.append(f"{match.group(1)} {match.group(2)}")

            # Extract markets
            for market in market_keywords:
                if market.lower() in msg.lower():
                    markets.add(market)

        return {
            "sender": sender,
            "message_count": len(rows),
            "groups": list(groups),
            "group_count": len(groups),
            "buildings": list(buildings)[:20],
            "bhk_configs": list(bhk_configs),
            "markets": list(markets),
            "price_patterns": price_patterns[:10],
            "first_seen": rows[-1][3],
            "last_seen": rows[0][3],
        }

    def get_sender_messages(self, sender: str, limit: int = 50) -> list[dict]:
        """Get raw messages from a sender (sanitized for display)."""
        rows = self.db.execute("""
            SELECT id, message, group_name, timestamp
            FROM raw_messages
            WHERE sender = ?
            ORDER BY timestamp DESC
            LIMIT ?
        """, (sender, limit)).fetchall()

        results = []
        for r in rows:
            # Resolve group name
            group_name = r[2]
            if group_name and '@g.us' in group_name:
                resolved = self.db.execute(
                    "SELECT group_name FROM source_sync_jobs WHERE group_id = ? LIMIT 1",
                    (group_name,)
                ).fetchone()
                if resolved:
                    group_name = resolved[0]

            results.append({
                "id": r[0],
                "message": r[1],
                "group_name": group_name,
                "timestamp": r[3],
            })

        return results

    def search_knowledge(self, query: str, limit: int = 20) -> dict:
        """
        Search across all knowledge: raw messages, parsed output, buildings, brokers.
        Returns unified results.
        """
        import re

        results = {
            "raw_messages": [],
            "buildings": [],
            "brokers": [],
            "total": 0,
        }

        # FTS5 search on raw messages
        try:
            rows = self.db.execute("""
                SELECT rm.id, rm.group_name, rm.sender, rm.sender_phone,
                       rm.message, rm.timestamp,
                       snippet(raw_messages_fts, 0, '<mark>', '</mark>', '...', 40) as snippet
                FROM raw_messages_fts fts
                JOIN raw_messages rm ON rm.id = fts.rowid
                WHERE raw_messages_fts MATCH ?
                ORDER BY rank
                LIMIT ?
            """, (query, limit)).fetchall()

            for r in rows:
                group_name = r[1]
                if group_name and '@g.us' in group_name:
                    resolved = self.db.execute(
                        "SELECT group_name FROM source_sync_jobs WHERE group_id = ? LIMIT 1",
                        (group_name,)
                    ).fetchone()
                    if resolved:
                        group_name = resolved[0]

                results["raw_messages"].append({
                    "id": r[0],
                    "group_name": group_name,
                    "sender": r[2],
                    "sender_phone": r[3],
                    "message": r[4],
                    "timestamp": r[5],
                    "snippet": r[6],
                })
        except Exception:
            # Fallback to LIKE
            like_q = f"%{query}%"
            rows = self.db.execute("""
                SELECT id, group_name, sender, sender_phone, message, timestamp
                FROM raw_messages
                WHERE message LIKE ?
                ORDER BY id DESC
                LIMIT ?
            """, (like_q, limit)).fetchall()

            for r in rows:
                group_name = r[1]
                if group_name and '@g.us' in group_name:
                    resolved = self.db.execute(
                        "SELECT group_name FROM source_sync_jobs WHERE group_id = ? LIMIT 1",
                        (group_name,)
                    ).fetchone()
                    if resolved:
                        group_name = resolved[0]

                results["raw_messages"].append({
                    "id": r[0],
                    "group_name": group_name,
                    "sender": r[2],
                    "sender_phone": r[3],
                    "message": r[4],
                    "timestamp": r[5],
                    "snippet": (r[4] or "")[:200],
                })

        # Search buildings
        building_rows = self.db.execute("""
            SELECT canonical_name, micro_market, observed_listings, observed_brokers
            FROM buildings
            WHERE canonical_name LIKE ?
            ORDER BY observed_listings DESC
            LIMIT 5
        """, (f"%{query}%",)).fetchall()

        for r in building_rows:
            results["buildings"].append({
                "name": r[0],
                "market": r[1],
                "listings": r[2],
                "brokers": r[3],
            })

        # Search brokers
        broker_rows = self.db.execute("""
            SELECT canonical_name, primary_phone, observation_count, listing_count
            FROM brokers
            WHERE canonical_name LIKE ? OR primary_phone LIKE ?
            ORDER BY observation_count DESC
            LIMIT 5
        """, (f"%{query}%", f"%{query}%")).fetchall()

        for r in broker_rows:
            results["brokers"].append({
                "name": r[0],
                "phone": r[1],
                "observations": r[2],
                "listings": r[3],
            })

        results["total"] = (
            len(results["raw_messages"]) +
            len(results["buildings"]) +
            len(results["brokers"])
        )

        return results

    # ── Knowledge Trainer ───────────────────────────────────────────

    def add_trainer_term(self, term: str, context: str = "", status: str = "pending") -> dict | None:
        """Add a term to the knowledge trainer queue."""
        try:
            self.db.execute("""
                INSERT INTO knowledge_trainer (term, context, status)
                VALUES (?, ?, ?)
                ON CONFLICT(term) DO UPDATE SET
                    frequency = frequency + 1,
                    last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                    context = ?
            """, (term.strip(), context, status, context))
            self.db.commit()
            return {"term": term.strip(), "status": status}
        except Exception as e:
            return {"error": str(e)}

    def get_trainer_terms(self, status: str | None = None, limit: int = 100) -> list[dict]:
        """Get terms from the knowledge trainer queue."""
        if status:
            rows = self.db.execute("""
                SELECT id, term, context, frequency, first_seen, last_seen, status, resolved_by, resolved_at
                FROM knowledge_trainer
                WHERE status = ?
                ORDER BY frequency DESC, last_seen DESC
                LIMIT ?
            """, (status, limit)).fetchall()
        else:
            rows = self.db.execute("""
                SELECT id, term, context, frequency, first_seen, last_seen, status, resolved_by, resolved_at
                FROM knowledge_trainer
                ORDER BY frequency DESC, last_seen DESC
                LIMIT ?
            """, (limit,)).fetchall()

        return [
            {
                "id": r[0], "term": r[1], "context": r[2],
                "frequency": r[3], "first_seen": r[4], "last_seen": r[5],
                "status": r[6], "resolved_by": r[7], "resolved_at": r[8],
            }
            for r in rows
        ]

    def resolve_trainer_term(self, term_id: int, status: str, resolved_by: str = "user") -> bool:
        """Resolve a trainer term (mark as building, society, landmark, locality, etc.)."""
        try:
            self.db.execute("""
                UPDATE knowledge_trainer
                SET status = ?, resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                WHERE id = ?
            """, (status, resolved_by, term_id))
            self.db.commit()
            return True
        except Exception:
            return False

    def ignore_trainer_term(self, term_id: int) -> bool:
        """Mark a trainer term as ignored."""
        return self.resolve_trainer_term(term_id, "ignored", "user")

    def get_trainer_stats(self) -> dict:
        """Get statistics for the knowledge trainer."""
        rows = self.db.execute("""
            SELECT status, COUNT(*) as cnt
            FROM knowledge_trainer
            GROUP BY status
        """).fetchall()

        stats = {r[0]: r[1] for r in rows}
        stats["total"] = sum(stats.values())
        stats["pending"] = stats.get("pending", 0)
        stats["resolved"] = stats.get("total", 0) - stats.get("pending", 0) - stats.get("ignored", 0)
        return stats

    def find_unknown_terms(self, limit: int = 50) -> list[dict]:
        """
        Find terms in raw messages that are NOT in known buildings, landmarks, or markets.
        These are candidates for the knowledge trainer.
        """
        import re

        # Get known entities from buildings table + building_name_aliases
        known_buildings = set()
        try:
            for r in self.db.execute("SELECT canonical_name FROM buildings WHERE canonical_name IS NOT NULL").fetchall():
                if r[0]:
                    known_buildings.add(r[0].lower())
            for r in self.db.execute("SELECT alias FROM building_name_aliases WHERE alias IS NOT NULL").fetchall():
                if r[0]:
                    known_buildings.add(r[0].lower())
        except Exception:
            pass

        known_markets = {"bandra", "andheri", "santacruz", "khar", "juhu", "goregaon", "malad", "worli", "powai", "bkc", "lokhandwala", "versova", "vile parle", "kurla", "ghatkopar", "mulund", "thane", "vashi", "nerul", "belapur", "kharghar"}
        known_landmarks = set()
        try:
            for r in self.db.execute("SELECT name FROM landmarks WHERE name IS NOT NULL").fetchall():
                if r[0]:
                    known_landmarks.add(r[0].lower())
        except Exception:
            pass

        # Stop words - common words that match building patterns but aren't buildings
        stop_words = {"the", "and", "for", "new", "old", "big", "the", "car", "com", "res", "app",
                       "flat", "room", "house", "rent", "sale", "buy", "sell", "deal", "call",
                       "contact", "details", "price", "rate", "cost", "total", "final", "net",
                       "best", "good", "nice", "fine", "great", "super", "top", "luxury",
                       "brand", "commercial", "residential", "premium", "exclusive", "special",
                       "independent", "bhk", "sqft", "ground", "floor", "upper", "lower",
                       "tower", "wing", "block", "section", "phase", "part", "type",
                       "lease", "production", "glass", "facade", "nana", "nani", "union",
                       "jodi", "sea", "view", "road", "nagar", "clear", "hindu", "available",
                       "facing", "neg", "lacs", "experience", "luxury", "brand", "new"}

        # Sample raw messages
        rows = self.db.execute("""
            SELECT id, message FROM raw_messages
            WHERE LENGTH(message) > 50
            ORDER BY RANDOM()
            LIMIT 200
        """).fetchall()

        # Extract potential building names
        term_freq = {}
        # More specific pattern: requires a proper noun followed by a building type suffix
        building_pattern = re.compile(r'\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)\s+(?:Bil\.?|Bldg\.?|Building|Apt\.?|Complex|Tower|Heights?|Park|Residency|Enclave|Villa|Society|CHS|Housing|Apartment|Ivory|Heights|Residences?|Nest|Abode|Haven|Vihar|Vatika|Gardens?|Groves?|Court|House|Mansion|Lodge|Retreat|Arcade|Plaza|Center|Centre|Quarters?)\b', re.IGNORECASE)
        # Also match short proper nouns that appear as building names in context
        short_pattern = re.compile(r'\b([A-Z][a-z]{3,})\s+(?:Bil|Bldg|Bldg|Apt|CHS|Society|Tower|Heights)\b', re.IGNORECASE)

        for row in rows:
            msg = row[1] or ""
            for match in building_pattern.finditer(msg):
                term = match.group(1).strip()
                term_lower = term.lower()

                # Skip if already known
                if term_lower in known_buildings or term_lower in known_markets or term_lower in known_landmarks:
                    continue

                if len(term) < 3:
                    continue

                # Skip stop words
                if term_lower in stop_words:
                    continue

                # Skip terms with newlines or special characters
                if '\n' in term or '\r' in term or len(term) > 30:
                    continue

                if term not in term_freq:
                    term_freq[term] = {"count": 0, "contexts": []}
                term_freq[term]["count"] += 1
                if len(term_freq[term]["contexts"]) < 3:
                    term_freq[term]["contexts"].append(msg[:100])

        # Sort by frequency and return top
        sorted_terms = sorted(term_freq.items(), key=lambda x: x[1]["count"], reverse=True)[:limit]

        return [
            {
                "term": term,
                "frequency": data["count"],
                "contexts": data["contexts"],
                "already_in_trainer": self.db.execute(
                    "SELECT id FROM knowledge_trainer WHERE term = ?", (term,)
                ).fetchone() is not None,
            }
            for term, data in sorted_terms
        ]


    # ── Knowledge Records (New Architecture) ───────────────────────

    def create_knowledge_record(self, record: dict) -> int | None:
        """Create a new knowledge record. Returns the record ID."""
        try:
            cursor = self.db.execute("""
                INSERT INTO knowledge_records (
                    source_type, source_id, raw_content, processed_content,
                    sender_jid, sender_name, sender_phone,
                    conversation_id, conversation_name,
                    message_timestamp, content_type, intent,
                    embedding_id, metadata, confidence
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                record.get("source_type", "unknown"),
                record.get("source_id"),
                record["raw_content"],
                record.get("processed_content"),
                record.get("sender_jid"),
                record.get("sender_name"),
                record.get("sender_phone"),
                record.get("conversation_id"),
                record.get("conversation_name"),
                record["message_timestamp"],
                record.get("content_type", "unknown"),
                record.get("intent"),
                record.get("embedding_id"),
                record.get("metadata", "{}"),
                record.get("confidence", 0.0),
            ))
            self.db.commit()
            return cursor.lastrowid
        except Exception as e:
            return None

    def bulk_create_knowledge_records(self, records: list[dict]) -> int:
        """Bulk insert knowledge records. Returns count of inserted records."""
        count = 0
        for record in records:
            if self.create_knowledge_record(record):
                count += 1
        return count

    def add_knowledge_tag(self, record_id: int, tag_type: str, tag_value: str,
                          confidence: float = 1.0, source: str = "system") -> bool:
        """Add a tag to a knowledge record."""
        try:
            self.db.execute("""
                INSERT INTO knowledge_tags (record_id, tag_type, tag_value, confidence, source)
                VALUES (?, ?, ?, ?, ?)
            """, (record_id, tag_type, tag_value, confidence, source))
            self.db.commit()
            return True
        except Exception:
            return False

    def bulk_add_knowledge_tags(self, record_id: int, tags: dict[str, list[str]],
                                 source: str = "system") -> int:
        """Bulk add tags. tags = {'building': ['Parijat'], 'bhk': ['2 BHK'], ...}"""
        count = 0
        for tag_type, values in tags.items():
            for value in values:
                if self.add_knowledge_tag(record_id, tag_type, value, source=source):
                    count += 1
        return count

    def add_knowledge_alias(self, alias: str, canonical: str, entity_type: str,
                            confidence: float = 1.0, source: str = "system") -> bool:
        """Add an alias mapping."""
        try:
            self.db.execute("""
                INSERT OR REPLACE INTO knowledge_aliases (alias, canonical, entity_type, confidence, source)
                VALUES (?, ?, ?, ?, ?)
            """, (alias.lower().strip(), canonical, entity_type, confidence, source))
            self.db.commit()
            return True
        except Exception:
            return False

    def resolve_alias(self, term: str, entity_type: str | None = None) -> str | None:
        """Resolve a term to its canonical form via aliases."""
        term_lower = term.lower().strip()
        if entity_type:
            row = self.db.execute(
                "SELECT canonical FROM knowledge_aliases WHERE alias = ? AND entity_type = ?",
                (term_lower, entity_type)
            ).fetchone()
        else:
            row = self.db.execute(
                "SELECT canonical FROM knowledge_aliases WHERE alias = ?",
                (term_lower,)
            ).fetchone()
        return row[0] if row else None

    def search_knowledge_records(self, query: str, limit: int = 20,
                                  content_type: str | None = None,
                                  sender_jid: str | None = None,
                                  conversation_id: str | None = None) -> list[dict]:
        """Search knowledge records using FTS5."""
        try:
            # Try FTS5 first
            where_clauses = []
            params = []

            if content_type:
                where_clauses.append("kr.content_type = ?")
                params.append(content_type)
            if sender_jid:
                where_clauses.append("kr.sender_jid = ?")
                params.append(sender_jid)
            if conversation_id:
                where_clauses.append("kr.conversation_id = ?")
                params.append(conversation_id)

            where_sql = " AND ".join(where_clauses) if where_clauses else "1=1"

            rows = self.db.execute(f"""
                SELECT kr.id, kr.source_type, kr.raw_content, kr.sender_name,
                       kr.sender_phone, kr.conversation_name, kr.message_timestamp,
                       kr.content_type, kr.intent, kr.confidence,
                       snippet(knowledge_records_fts, 0, '<mark>', '</mark>', '...', 40) as snippet
                FROM knowledge_records_fts fts
                JOIN knowledge_records kr ON kr.id = fts.rowid
                WHERE knowledge_records_fts MATCH ? AND {where_sql}
                ORDER BY rank
                LIMIT ?
            """, [query] + params + [limit]).fetchall()

            return [
                {
                    "id": r[0], "source_type": r[1], "raw_content": r[2],
                    "sender_name": r[3], "sender_phone": r[4],
                    "conversation_name": r[5], "timestamp": r[6],
                    "content_type": r[7], "intent": r[8], "confidence": r[9],
                    "snippet": r[10],
                }
                for r in rows
            ]
        except Exception:
            # Fallback to LIKE
            like_q = f"%{query}%"
            rows = self.db.execute("""
                SELECT id, source_type, raw_content, sender_name,
                       sender_phone, conversation_name, message_timestamp,
                       content_type, intent, confidence
                FROM knowledge_records
                WHERE raw_content LIKE ? AND is_valid = 1
                ORDER BY message_timestamp DESC
                LIMIT ?
            """, (like_q, limit)).fetchall()

            return [
                {
                    "id": r[0], "source_type": r[1], "raw_content": r[2],
                    "sender_name": r[3], "sender_phone": r[4],
                    "conversation_name": r[5], "timestamp": r[6],
                    "content_type": r[7], "intent": r[8], "confidence": r[9],
                    "snippet": r[2][:100] + "..." if r[2] else "",
                }
                for r in rows
            ]

    def get_knowledge_record(self, record_id: int) -> dict | None:
        """Get a single knowledge record by ID."""
        row = self.db.execute("""
            SELECT id, source_type, source_id, raw_content, processed_content,
                   sender_jid, sender_name, sender_phone,
                   conversation_id, conversation_name,
                   message_timestamp, ingested_at,
                   content_type, intent, embedding_id,
                   metadata, confidence, is_valid,
                   created_at, updated_at
            FROM knowledge_records WHERE id = ?
        """, (record_id,)).fetchone()

        if not row:
            return None

        # Get tags
        tags = self.db.execute(
            "SELECT tag_type, tag_value, confidence FROM knowledge_tags WHERE record_id = ?",
            (record_id,)
        ).fetchall()

        return {
            "id": row[0], "source_type": row[1], "source_id": row[2],
            "raw_content": row[3], "processed_content": row[4],
            "sender_jid": row[5], "sender_name": row[6], "sender_phone": row[7],
            "conversation_id": row[8], "conversation_name": row[9],
            "message_timestamp": row[10], "ingested_at": row[11],
            "content_type": row[12], "intent": row[13], "embedding_id": row[14],
            "metadata": row[15], "confidence": row[16], "is_valid": row[17],
            "created_at": row[18], "updated_at": row[19],
            "tags": {r[0]: r[1] for r in tags},
        }

    def update_knowledge_record(self, record_id: int, updates: dict) -> bool:
        """Update a knowledge record."""
        allowed_fields = {
            "processed_content", "content_type", "intent",
            "embedding_id", "metadata", "confidence", "is_valid"
        }
        fields = {k: v for k, v in updates.items() if k in allowed_fields}
        if not fields:
            return False

        set_clause = ", ".join(f"{k} = ?" for k in fields)
        values = list(fields.values()) + [record_id]

        try:
            self.db.execute(
                f"UPDATE knowledge_records SET {set_clause}, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?",
                values
            )
            self.db.commit()
            return True
        except Exception:
            return False

    def get_knowledge_stats(self) -> dict:
        """Get statistics for knowledge records."""
        row = self.db.execute("""
            SELECT
                COUNT(*) as total,
                COUNT(DISTINCT sender_jid) as unique_senders,
                COUNT(DISTINCT conversation_id) as unique_conversations,
                SUM(CASE WHEN content_type = 'listing' THEN 1 ELSE 0 END) as listings,
                SUM(CASE WHEN content_type = 'requirement' THEN 1 ELSE 0 END) as requirements,
                SUM(CASE WHEN content_type = 'unknown' THEN 1 ELSE 0 END) as unclassified
            FROM knowledge_records
            WHERE is_valid = 1
        """).fetchone()

        return {
            "total_records": row[0],
            "unique_senders": row[1],
            "unique_conversations": row[2],
            "listings": row[3],
            "requirements": row[4],
            "unclassified": row[5],
        }

    def add_learning_card(self, term: str, context: str = "", frequency: int = 1) -> int | None:
        """Add a term to the learning queue."""
        try:
            cursor = self.db.execute("""
                INSERT INTO learning_cards (term, context, frequency)
                VALUES (?, ?, ?)
                ON CONFLICT(term) DO UPDATE SET
                    frequency = frequency + ?,
                    last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
            """, (term.strip(), context, frequency, frequency))
            self.db.commit()
            return cursor.lastrowid
        except Exception:
            return None

    def resolve_learning_card(self, card_id: int, resolved_type: str, resolved_value: str,
                               resolved_by: str = "user") -> bool:
        """Resolve a learning card."""
        try:
            self.db.execute("""
                UPDATE learning_cards
                SET status = 'resolved', resolved_type = ?, resolved_value = ?,
                    resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
                WHERE id = ?
            """, (resolved_type, resolved_value, resolved_by, card_id))
            self.db.commit()

            # Also add to knowledge_aliases
            if resolved_type in ("building", "market", "landmark"):
                card = self.db.execute("SELECT term FROM learning_cards WHERE id = ?", (card_id,)).fetchone()
                if card:
                    self.add_knowledge_alias(card[0], resolved_value, resolved_type, source="user")
            return True
        except Exception:
            return False

    def get_learning_cards(self, status: str = "pending", limit: int = 100) -> list[dict]:
        """Get learning cards."""
        rows = self.db.execute("""
            SELECT id, term, context, frequency, first_seen, last_seen,
                   status, resolved_type, resolved_value, resolved_by, resolved_at
            FROM learning_cards
            WHERE status = ?
            ORDER BY frequency DESC
            LIMIT ?
        """, (status, limit)).fetchall()

        return [
            {
                "id": r[0], "term": r[1], "context": r[2], "frequency": r[3],
                "first_seen": r[4], "last_seen": r[5], "status": r[6],
                "resolved_type": r[7], "resolved_value": r[8],
                "resolved_by": r[9], "resolved_at": r[10],
            }
            for r in rows
        ]

    def search_knowledge_with_embeddings(self, query: str, limit: int = 10) -> list[dict]:
        """Search knowledge records using embeddings for semantic similarity."""
        try:
            from knowledge.embedder import get_embedder
            embedder = get_embedder()
            return embedder.search_similar(query, limit=limit)
        except Exception:
            # Fallback to FTS5
            return self.search_knowledge_records(query, limit=limit)

    def get_embedding_stats(self) -> dict:
        """Get embedding statistics."""
        try:
            from knowledge.embedder import get_embedder
            embedder = get_embedder()
            return embedder.get_vocabulary_stats()
        except Exception:
            return {"vocab_size": 0, "total_records": 0, "embedded_records": 0}


def _parse_bhk(bhk_str: str) -> int | None:
    """Parse '2 BHK', '3 BHK', '1RK' etc. to number."""
    if not bhk_str:
        return None
    s = bhk_str.upper().strip()
    if 'RK' in s:
        return 0.5
    import re
    m = re.search(r'(\d+)', s)
    return int(m.group(1)) if m else None


def _normalize_price(price: float, unit: str | None) -> float | None:
    """Normalize price to absolute rupees."""
    if not price or price <= 0:
        return None
    if not unit:
        return price
    u = unit.upper().strip()
    if u in ('CR', 'CRORE', 'CRORES'):
        return price * 10_00_000
    elif u in ('L', 'LAC', 'LACS', 'LAKH', 'LAKHS'):
        return price * 1_00_000
    elif u in ('K', 'THOUSAND'):
        return price * 1_000
    elif u in ('ABS', 'ABSOLUTE', 'RS', 'RUPEES', ''):
        return price
    return price
