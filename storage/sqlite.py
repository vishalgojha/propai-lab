"""SQLite implementation of the Storage interface."""

import json
import re
import sqlite3
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone
from difflib import SequenceMatcher
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
            "CREATE TABLE IF NOT EXISTS knowledge_trainer (id INTEGER PRIMARY KEY AUTOINCREMENT, term TEXT UNIQUE, context TEXT DEFAULT '', status TEXT DEFAULT 'pending', frequency INTEGER DEFAULT 1, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), last_seen TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), resolved_by TEXT DEFAULT NULL, resolved_at TEXT DEFAULT NULL, notes TEXT DEFAULT NULL, raw_message_id INTEGER DEFAULT NULL, resolver_decision_id INTEGER DEFAULT NULL)",
            "CREATE TABLE IF NOT EXISTS knowledge_learning_candidates (id INTEGER PRIMARY KEY AUTOINCREMENT, phrase TEXT UNIQUE, frequency INTEGER DEFAULT 1, first_seen TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), last_seen TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), confidence REAL DEFAULT 0.0, contexts TEXT DEFAULT '[]', raw_message_ids TEXT DEFAULT '[]', source TEXT DEFAULT 'scanner', status TEXT DEFAULT 'candidate')",
            "CREATE TABLE IF NOT EXISTS knowledge_aliases (id INTEGER PRIMARY KEY AUTOINCREMENT, alias TEXT NOT NULL, canonical TEXT NOT NULL, entity_type TEXT NOT NULL, confidence REAL DEFAULT 1.0, source TEXT DEFAULT 'system', created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), locality TEXT DEFAULT '', price_min REAL DEFAULT 0, price_max REAL DEFAULT 0)",
            "CREATE TABLE IF NOT EXISTS combined_locality_rules (id INTEGER PRIMARY KEY AUTOINCREMENT, surface TEXT NOT NULL UNIQUE, expands_to TEXT NOT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))",
            "ALTER TABLE knowledge_aliases ADD COLUMN intel TEXT DEFAULT '{}'",
            "ALTER TABLE brokers ADD COLUMN building_count INTEGER DEFAULT 0",
            "ALTER TABLE brokers ADD COLUMN active_days_30 INTEGER DEFAULT 0",
            "ALTER TABLE parsed_output ADD COLUMN summary_title TEXT DEFAULT NULL",
            "CREATE TABLE IF NOT EXISTS observations (id INTEGER PRIMARY KEY AUTOINCREMENT, fingerprint TEXT NOT NULL, broker_key TEXT NOT NULL, summary_title TEXT DEFAULT '', intent TEXT, bhk TEXT, price REAL, price_unit TEXT, building_name TEXT, micro_market TEXT, location_raw TEXT, first_seen TEXT, last_seen TEXT, times_seen INTEGER DEFAULT 1, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), UNIQUE(broker_key, fingerprint))",
            "CREATE TABLE IF NOT EXISTS observation_evidence (id INTEGER PRIMARY KEY AUTOINCREMENT, observation_id INTEGER NOT NULL, raw_message_id INTEGER NOT NULL, parsed_id INTEGER NOT NULL, evidence_type TEXT DEFAULT 'group', source_conversation TEXT DEFAULT '', seen_at TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), FOREIGN KEY (observation_id) REFERENCES observations(id), FOREIGN KEY (raw_message_id) REFERENCES raw_messages(id), FOREIGN KEY (parsed_id) REFERENCES parsed_output(id), UNIQUE(observation_id, raw_message_id))",
            "CREATE TABLE IF NOT EXISTS team_members (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT UNIQUE DEFAULT '', phone TEXT DEFAULT '', role TEXT NOT NULL DEFAULT 'member', permissions INTEGER NOT NULL DEFAULT 0, is_active INTEGER NOT NULL DEFAULT 1, linked_broker_phone TEXT DEFAULT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), updated_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')))",
            "CREATE TABLE IF NOT EXISTS activity_log (id INTEGER PRIMARY KEY AUTOINCREMENT, team_member_id INTEGER NOT NULL, action TEXT NOT NULL, target_type TEXT DEFAULT '', target_id TEXT DEFAULT '', details TEXT DEFAULT '{}', ip_address TEXT DEFAULT '', created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), FOREIGN KEY (team_member_id) REFERENCES team_members(id))",
            "CREATE TABLE IF NOT EXISTS team_member_whatsapp_access (id INTEGER PRIMARY KEY AUTOINCREMENT, team_member_id INTEGER NOT NULL, whatsapp_number TEXT NOT NULL, can_send INTEGER NOT NULL DEFAULT 0, can_view_messages INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), FOREIGN KEY (team_member_id) REFERENCES team_members(id), UNIQUE(team_member_id, whatsapp_number))",
            "CREATE TABLE IF NOT EXISTS chat_assignments (id INTEGER PRIMARY KEY AUTOINCREMENT, whatsapp_number TEXT NOT NULL, remote_jid TEXT NOT NULL, assigned_to INTEGER DEFAULT NULL, taken_over_by INTEGER DEFAULT NULL, taken_over_at TEXT DEFAULT NULL, released_at TEXT DEFAULT NULL, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')), FOREIGN KEY (assigned_to) REFERENCES team_members(id), FOREIGN KEY (taken_over_by) REFERENCES team_members(id), UNIQUE(whatsapp_number, remote_jid))",
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

    GENERIC_NAMES = frozenset({
        "real estate", "property", "properties", "realtor", "broker", "agent",
        "consultant", "advisor", "realty", "estate", "group", "team",
    })

    @staticmethod
    def _extract_name_from_message(message: str | None) -> str | None:
        """Extract broker name from message signature (text after phone number at end)."""
        if not message:
            return None
        # Phone number on its own line, name on next line
        m = re.search(r'(\d{10,12})\s*\n\s*([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)', message)
        if m:
            return m.group(2).strip()
        # Phone number then name on same line at end
        m = re.search(r'(\d{10,12})\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)\s*$', message)
        if m:
            return m.group(2).strip()
        return None

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
                       r.group_name, r.sender, r.message, r.timestamp
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
            if not name or name.strip().lower() in self.GENERIC_NAMES:
                sig_name = self._extract_name_from_message(d.get("message"))
                if sig_name:
                    name = sig_name
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
            seen_values = [t for t in seen_times if t]
            first_seen = min(seen_values) if seen_values else None
            last_seen = max(seen_values) if seen_values else None

            # Coverage: unique buildings
            buildings = set()
            active_dates = set()
            for item in items:
                bn = item.get("building_name")
                if bn and bn.strip() and bn.strip() != "-":
                    buildings.add(bn.strip())
                seen_date = (item.get("timestamp") or item.get("created_at") or "")[:10]
                if seen_date and len(seen_date) == 10:
                    active_dates.add(seen_date)
            building_count = len(buildings)
            thirty_days_ago = (datetime.now(timezone.utc) - timedelta(days=30)).strftime("%Y-%m-%d")
            active_days_30 = len([d for d in active_dates if d >= thirty_days_ago])

            broker_id = existing_brokers.get(key)
            if broker_id:
                self.db.execute(
                    """UPDATE brokers
                       SET canonical_name = ?, primary_phone = ?, first_seen_at = ?,
                           last_seen_at = ?, observation_count = ?, listing_count = ?,
                           requirement_count = ?, rental_count = ?, commercial_count = ?,
                           group_count = ?, market_count = ?, building_count = ?,
                           active_days_30 = ?, updated_at = ?
                       WHERE id = ?""",
                    (canonical_name, primary_phone, first_seen, last_seen, len(items),
                     listing_count, requirement_count, rental_count, commercial_count,
                     len(groups), len(markets), building_count, active_days_30, now, broker_id),
                )
            else:
                cur = self.db.execute(
                    """INSERT INTO brokers
                       (identity_key, canonical_name, primary_phone, first_seen_at, last_seen_at,
                        observation_count, listing_count, requirement_count, rental_count,
                        commercial_count, group_count, market_count, building_count,
                        active_days_30, updated_at)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (key, canonical_name, primary_phone, first_seen, last_seen, len(items),
                     listing_count, requirement_count, rental_count, commercial_count,
                     len(groups), len(markets), building_count, active_days_30, now),
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

    def _observation_fingerprint(self, parsed: dict) -> str:
        import hashlib
        broker_parts = [
            str(parsed.get("broker_name") or parsed.get("profile_name") or "").strip().lower(),
            re.sub(r"\D+", "", parsed.get("broker_phone") or ""),
        ]
        content_parts = [
            str(parsed.get("intent") or "").strip().lower(),
            str(parsed.get("bhk") or "").strip().lower(),
            f"{float(parsed.get('price') or 0):.0f}",
            str(parsed.get("building_name") or "").strip().lower(),
            str(parsed.get("micro_market") or "").strip().lower(),
            str(parsed.get("location_raw") or "").strip().lower(),
        ]
        raw = "::".join(filter(None, broker_parts)) + "||" + "::".join(filter(None, content_parts))
        return hashlib.sha256(raw.encode()).hexdigest()

    def rebuild_observation_graph(self) -> dict:
        rows = self.db.execute(
            """SELECT p.id AS parsed_id, p.raw_message_id, p.intent, p.bhk,
                      p.price, p.price_unit, p.building_name, p.micro_market,
                      p.location_raw, p.broker_name, p.broker_phone, p.profile_name,
                      p.summary_title, p.created_at,
                      r.group_name, r.timestamp, r.sender_jid, r.message
               FROM parsed_output p
               JOIN raw_messages r ON r.id = p.raw_message_id
               WHERE COALESCE(p.broker_name, p.profile_name, r.sender, '') != ''
               ORDER BY p.id"""
        ).fetchall()

        self.db.execute("DELETE FROM observation_evidence")
        self.db.execute("DELETE FROM observations")

        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        obs_map: dict[str, dict] = {}

        for row in rows:
            d = dict(row)
            # Backfill null parsed fields from raw message text
            raw_text = d.get("message") or ""
            backfilled = self._backfill_parsed(raw_text, d)
            d["intent"] = backfilled["intent"]
            d["building_name"] = backfilled["building_name"]
            d["micro_market"] = backfilled["micro_market"]
            d["location_raw"] = backfilled["location_raw"]
            # Always regenerate title during rebuild with backfilled data
            existing_title = d.get("summary_title") or ""
            # Title is missing location — rebuild it
            new_parts: list[str] = []
            lower = raw_text.lower()
            # Trans type
            tt = None
            if re.search(r'\bfor\s+sale\b', lower) or re.search(r'\bonsale\b', lower):
                tt = "Sale"
            elif re.search(r'\b(?:for\s+)?rent\b', lower):
                tt = "Rent"
            elif re.search(r'\bleased?\b', lower):
                tt = "Lease"
            if tt:
                new_parts.append(tt)
            # Property type
            pt = None
            for pat, label in [
                (r'\bflat\b', "Flat"), (r'\boffice\b', "Office"),
                (r'\bshop\b', "Shop"), (r'\bshowroom\b', "Showroom"),
                (r'\bbungalow\b', "Bungalow"), (r'\bvilla\b', "Villa"),
                (r'\bgodown\b', "Godown"), (r'\bwarehouse\b', "Warehouse"),
                (r'\bcommercial\b', "Commercial"),
            ]:
                if re.search(pat, lower):
                    pt = label
                    break
            if pt:
                new_parts.append(pt)
            # Location — prefer micro_market, validate location_raw against known patterns
            loc = d.get("micro_market")
            if not loc:
                loc_raw = d.get("location_raw")
                if loc_raw:
                    # Only accept location_raw if it matches a known Mumbai locality
                    loc_pats_combined = '|'.join([
                        r'Andheri\s*(?:\(\s*[EW]\s*\)|\s+(?:East|West))?',
                        r'Bandra\s*(?:East|West)?',
                        r'Juhu', r'Khar\s*(?:East|West)?', r'Dadar',
                        r'Worli', r'Malad\s*(?:East|West)?', r'Powai',
                        r'Goregaon\s*(?:East|West)?', r'Kandivali\s*(?:East|West)?',
                        r'Borivali\s*(?:East|West)?', r'Dombivli', r'Thane',
                        r'Navi\s+Mumbai', r'Nerul', r'Vashi', r'Panvel',
                        r'Chembur', r'Kurla', r'Ghatkopar', r'Vile\s+Parle',
                        r'Lower\s+Para?l', r'Prabhadevi', r'Marine\s+Lines?',
                        r'Colaba', r'Churchgate', r'Fort', r'Byculla',
                        r'Mahim', r'Matunga', r'Sion', r'Wadala',
                        r'Dahisar', r'Mira\s+Road', r'Bhayandar',
                        r'Vasai', r'Virar', r'Kalyan', r'Ambernath',
                        r'Badlapur', r'Ulhasnagar',
                    ])
                    if re.search(loc_pats_combined, loc_raw, re.IGNORECASE):
                        loc = str(loc_raw).strip()
            if loc:
                new_parts.append(loc)
            # Building
            bldg = d.get("building_name")
            if bldg:
                new_parts.append(str(bldg))
            # Price
            price = d.get("price")
            unit = d.get("price_unit") or ""
            if price:
                new_parts.append(f"₹{price:g} {unit}".strip())
            if new_parts:
                d["summary_title"] = " | ".join(new_parts)
            fp = self._observation_fingerprint(d)
            if fp not in obs_map:
                obs_map[fp] = {
                    "fingerprint": fp,
                    "broker_key": re.sub(r"\D+", "", d.get("broker_phone") or ""),
                    "summary_title": d.get("summary_title") or "",
                    "intent": d.get("intent"),
                    "bhk": d.get("bhk"),
                    "price": d.get("price"),
                    "price_unit": d.get("price_unit"),
                    "building_name": d.get("building_name"),
                    "micro_market": d.get("micro_market"),
                    "location_raw": d.get("location_raw"),
                    "first_seen": d.get("timestamp") or d.get("created_at") or now,
                    "last_seen": d.get("timestamp") or d.get("created_at") or now,
                    "times_seen": 0,
                    "evidence": [],
                }
            existing = obs_map[fp]
            seen_at = d.get("timestamp") or d.get("created_at") or now
            if seen_at < existing["first_seen"]:
                existing["first_seen"] = seen_at
            if seen_at > existing["last_seen"]:
                existing["last_seen"] = seen_at
                if d.get("summary_title"):
                    existing["summary_title"] = d["summary_title"]
            existing["times_seen"] += 1
            existing["evidence"].append({
                "raw_message_id": d["raw_message_id"],
                "parsed_id": d["parsed_id"],
                "group_name": d.get("group_name") or "",
                "sender_jid": d.get("sender_jid") or "",
                "seen_at": seen_at,
            })

        for fp, obs in obs_map.items():
            cur = self.db.execute(
                """INSERT INTO observations
                   (fingerprint, broker_key, summary_title, intent, bhk, price, price_unit,
                    building_name, micro_market, location_raw, first_seen, last_seen, times_seen)
                   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
                (obs["fingerprint"], obs["broker_key"], obs["summary_title"],
                 obs["intent"], obs["bhk"], obs["price"], obs["price_unit"],
                 obs["building_name"], obs["micro_market"], obs["location_raw"],
                 obs["first_seen"], obs["last_seen"], obs["times_seen"]),
            )
            obs_id = cur.lastrowid
            for ev in obs["evidence"]:
                group_name = (ev["group_name"] or "").strip()
                sender_jid = (ev["sender_jid"] or "").strip()
                is_dm = not group_name and bool(sender_jid)
                evidence_type = "dm" if is_dm else ("broadcast" if "broadcast" in group_name.lower() else "group")
                source_conversation = sender_jid if is_dm else group_name
                self.db.execute(
                    """INSERT OR IGNORE INTO observation_evidence
                       (observation_id, raw_message_id, parsed_id, evidence_type,
                        source_conversation, seen_at)
                       VALUES (?,?,?,?,?,?)""",
                    (obs_id, ev["raw_message_id"], ev["parsed_id"],
                     evidence_type, source_conversation, ev["seen_at"]),
                )

        self._commit()
        return {"observations": len(obs_map), "evidence": sum(o["times_seen"] for o in obs_map.values())}

    @staticmethod
    def _backfill_parsed(raw_text: str, parsed: dict) -> dict:
        """Fill null parsed fields by extracting from raw text directly."""
        result = dict(parsed)
        lower = raw_text.lower()

        # Backfill intent
        if not result.get("intent"):
            if re.search(r'\bfor\s+sale\b', lower) or re.search(r'\bonsale\b', lower):
                result["intent"] = "SELL"
            elif re.search(r'\b(?:for\s+)?rent\b', lower) or re.search(r'\bleased?\b', lower):
                result["intent"] = "RENT"

        # Backfill building name — look for quoted text, conservative only
        if not result.get("building_name"):
            raw_one_line = raw_text.split("\n")[0] if raw_text else ""
            # Match text in quotes on the first line (most reliable)
            bm = re.search(r'["\u201C\u201D]([^"\u201C\u201D]{3,50})["\u201C\u201D]', raw_one_line)
            if bm:
                cand = bm.group(1).strip().strip("_").strip()
                if cand and not re.search(r'(price|lac|cr|sqft|floor|contact|call|property|available|building|tower)', cand, re.IGNORECASE):
                    result["building_name"] = cand
            if not result.get("building_name"):
                # Match markdown-wrapped: _"text"_ or _text_ (common in WhatsApp)
                bm = re.search(r'_"([A-Z][A-Za-z0-9\s\-.]{3,50})"_', raw_text)
                if bm:
                    result["building_name"] = bm.group(1).strip()
            if not result.get("building_name"):
                # Last resort: first capitalized multi-word (2-4 words) on line 1
                bm = re.search(r'(?:^|\s)([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,3})(?:\s|$)', raw_one_line)
                if bm:
                    cand = bm.group(1).strip()
                    if cand and not any(kw in cand.lower() for kw in ["price", "lac", "cr", "sqft", "call", "contact", "property", "please", "kindly", "available", "required"]):
                        if len(cand) >= 5 and len(cand) <= 40:
                            result["building_name"] = cand

        # Backfill micro_market / location_raw
        if not result.get("micro_market") and not result.get("location_raw"):
            locs = [
                r'Andheri\s*\(\s*[EW]\s*\)',
                r'Andheri\s+(?:East|West)',
                r'Bandra\s+(?:East|West)',
                r'Bandra',
                r'Juhu',
                r'Khar\s+(?:East|West)',
                r'Khar',
                r'Dadar',
                r'Worli',
                r'Malad\s+(?:East|West)',
                r'Powai',
                r'Goregaon\s+(?:East|West)',
                r'Kandivali\s+(?:East|West)',
                r'Borivali\s+(?:East|West)',
                r'Dombivli',
                r'Thane',
                r'Navi\s+Mumbai',
                r'Nerul',
                r'Vashi',
                r'Panvel',
                r'Chembur',
                r'Kurla',
                r'Ghatkopar',
                r'Vile\s+Parle',
                r'Lower\s+Para?l',
                r'Prabhadevi',
                r'Marine\s+Lines?',
                r'Colaba',
                r'Churchgate',
                r'Fort',
                r'Byculla',
                r'Mahim',
                r'Matunga',
                r'Sion',
                r'Wadala',
                r'Dahisar',
                r'Mira\s+Road',
                r'Bhayandar',
                r'Vasai',
                r'Virar',
                r'Kalyan',
                r'Ambernath',
                r'Badlapur',
                r'Ulhasnagar',
            ]
            for pat in locs:
                lm = re.search(pat, raw_text, re.IGNORECASE)
                if lm:
                    loc_raw = lm.group(0)
                    # Normalize: "Andheri (W)" -> "Andheri West"
                    loc_normalized = re.sub(r'\(\s*([EW])\s*\)', lambda m: {"E": "East", "W": "West"}.get(m.group(1).upper(), m.group(1)), loc_raw)
                    loc_normalized = loc_normalized.replace("_", " ").strip()
                    result["location_raw"] = loc_raw
                    result["micro_market"] = loc_normalized
                    break

        return result

    def _add_parsed_evidence(self, parsed_id: int, obs: ParsedObservation, raw_message_id: int):
        try:
            raw = self.db.execute(
                "SELECT group_name, sender_jid, timestamp, message FROM raw_messages WHERE id = ?",
                (raw_message_id,),
            ).fetchone()
            if not raw:
                return

            raw_text = raw["message"] or ""
            backfilled = self._backfill_parsed(raw_text, {
                "broker_name": obs.broker_name,
                "broker_phone": obs.broker_phone,
                "profile_name": obs.profile_name,
                "intent": obs.intent,
                "bhk": obs.bhk,
                "price": obs.price,
                "building_name": obs.building_name,
                "micro_market": obs.micro_market,
                "location_raw": obs.location_raw,
            })

            fp = self._observation_fingerprint(backfilled)
            broker_key = re.sub(r"\D+", "", obs.broker_phone or "")
            seen_at = raw["timestamp"] or datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            group_name = (raw["group_name"] or "").strip()
            sender_jid = (raw["sender_jid"] or "").strip()
            is_dm = not group_name and bool(sender_jid)
            evidence_type = "dm" if is_dm else ("broadcast" if "broadcast" in group_name.lower() else "group")
            source_conversation = sender_jid if is_dm else group_name

            existing = self.db.execute(
                "SELECT id, times_seen FROM observations WHERE broker_key = ? AND fingerprint = ?",
                (broker_key, fp),
            ).fetchone()

            if existing:
                self.db.execute(
                    """UPDATE observations SET times_seen = times_seen + 1,
                       last_seen = MAX(last_seen, ?),
                       first_seen = MIN(first_seen, ?)
                       WHERE id = ?""",
                    (seen_at, seen_at, existing["id"]),
                )
                obs_id = existing["id"]
            else:
                title = obs.summary_title or ""
                cur = self.db.execute(
                    """INSERT INTO observations
                       (fingerprint, broker_key, summary_title, intent, bhk, price, price_unit,
                        building_name, micro_market, location_raw, first_seen, last_seen, times_seen)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1)""",
                    (fp, broker_key, title,
                     backfilled["intent"], obs.bhk, obs.price, obs.price_unit,
                     backfilled["building_name"], backfilled["micro_market"], backfilled["location_raw"],
                     seen_at, seen_at),
                )
                obs_id = cur.lastrowid

            try:
                self.db.execute(
                    """INSERT OR IGNORE INTO observation_evidence
                       (observation_id, raw_message_id, parsed_id, evidence_type,
                        source_conversation, seen_at)
                       VALUES (?,?,?,?,?,?)""",
                    (obs_id, raw_message_id, parsed_id, evidence_type, source_conversation, seen_at),
                )
            except Exception:
                pass
            self._commit()
        except Exception:
            pass

    def get_observations_feed(self, limit: int = 50, offset: int = 0,
                              broker_key: str = "", intent: str = "") -> list[dict]:
        where = []
        params: list = []
        if broker_key:
            where.append("o.broker_key = ?")
            params.append(broker_key)
        if intent:
            where.append("o.intent = ?")
            params.append(intent.upper())

        where_sql = ("WHERE " + " AND ".join(where)) if where else ""
        params.extend([limit, offset])

        rows = self.db.execute(
            f"""SELECT o.id, o.fingerprint, o.broker_key, o.summary_title,
                       o.intent, o.bhk, o.price, o.price_unit,
	                       o.building_name, o.micro_market, o.location_raw,
	                       o.first_seen, o.last_seen, o.times_seen,
	                       COALESCE(e.evidence_json, '[]') AS evidence_list,
	                       (SELECT oe4.raw_message_id FROM observation_evidence oe4
	                        WHERE oe4.observation_id = o.id
	                        ORDER BY oe4.seen_at DESC LIMIT 1) AS latest_raw_message_id,
	                       (SELECT oe5.parsed_id FROM observation_evidence oe5
	                        WHERE oe5.observation_id = o.id
	                        ORDER BY oe5.seen_at DESC LIMIT 1) AS latest_parsed_id,
	                       (SELECT rm.message FROM observation_evidence oe2
	                        JOIN raw_messages rm ON rm.id = oe2.raw_message_id
	                        WHERE oe2.observation_id = o.id
                        ORDER BY oe2.seen_at DESC LIMIT 1) AS raw_message,
                       (SELECT rm.sender FROM observation_evidence oe3
                        JOIN raw_messages rm ON rm.id = oe3.raw_message_id
                        WHERE oe3.observation_id = o.id
                        ORDER BY oe3.seen_at DESC LIMIT 1) AS raw_sender
                FROM observations o
                LEFT JOIN (
                    SELECT observation_id,
                           json_group_array(
                               json_object('type', evidence_type, 'source', source_conversation, 'seen_at', seen_at)
                           ) AS evidence_json
                    FROM observation_evidence
                    GROUP BY observation_id
                ) e ON e.observation_id = o.id
                {where_sql}
                ORDER BY o.last_seen DESC
                LIMIT ? OFFSET ?""",
            params,
        ).fetchall()

        result = []
        for r in rows:
            d = dict(r)
            d["evidence_list"] = json.loads(d.get("evidence_list") or "[]")
            result.append(d)
        return result

    def get_brokers_feed(self, limit: int = 50, offset: int = 0,
                         min_observations: int = 1) -> list[dict]:
        rows = self.db.execute(
            """SELECT
                   b.primary_phone, b.canonical_name,
                   b.building_count, b.active_days_30,
                   COUNT(DISTINCT o.id) AS observation_count,
                   MAX(o.last_seen) AS last_active,
                   MIN(o.first_seen) AS first_seen,
                   SUM(CASE WHEN oe.evidence_type = 'group' THEN 1 ELSE 0 END) AS group_evidence_count,
                   SUM(CASE WHEN oe.evidence_type = 'dm' THEN 1 ELSE 0 END) AS dm_evidence_count,
                   COUNT(DISTINCT oe.source_conversation) AS unique_channel_count,
                   (SELECT o2.summary_title FROM observations o2
                    WHERE o2.broker_key = b.primary_phone
                    ORDER BY o2.last_seen DESC LIMIT 1) AS latest_title,
                   (SELECT o2.intent FROM observations o2
                    WHERE o2.broker_key = b.primary_phone
                    ORDER BY o2.last_seen DESC LIMIT 1) AS latest_intent,
                   (SELECT COALESCE(json_group_array(DISTINCT json_object(
                       'source', oe2.source_conversation,
                       'type', oe2.evidence_type
                   )), '[]')
                    FROM observation_evidence oe2
                    JOIN observations o2 ON o2.id = oe2.observation_id
                    WHERE o2.broker_key = b.primary_phone) AS channels
               FROM brokers b
               JOIN observations o ON o.broker_key = b.primary_phone
               JOIN observation_evidence oe ON oe.observation_id = o.id
               GROUP BY b.primary_phone
               HAVING observation_count >= ?
               ORDER BY last_active DESC
               LIMIT ? OFFSET ?""",
            (min_observations, limit, offset),
        ).fetchall()

        result = []
        for r in rows:
            d = dict(r)
            d["group_evidence_count"] = d["group_evidence_count"] or 0
            d["dm_evidence_count"] = d["dm_evidence_count"] or 0
            d["unique_channel_count"] = d["unique_channel_count"] or 0
            d["building_count"] = d["building_count"] or 0
            d["active_days_30"] = d["active_days_30"] or 0
            d["channels"] = json.loads(d.get("channels") or "[]")
            result.append(d)
        return result

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
                profile_name, listing_index, forwarded, confidence, raw_payload, event_id, embedding,
                summary_title)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (obs.raw_message_id, obs.message_type, obs.intent, obs.principal, obs.bhk,
             obs.price, obs.price_unit, obs.area_sqft, obs.furnishing, obs.location_raw,
             obs.location,
             obs.building_name, obs.landmark_name, obs.street_name,
             obs.area, obs.micro_market, obs.developer,
             obs.broker_name, obs.broker_phone,
             obs.profile_name, obs.listing_index,
             obs.forwarded,
             obs.confidence, obs.raw_payload, obs.event_id,
             obs.embedding,
             obs.summary_title)
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
            self._add_parsed_evidence(parsed_id, obs, obs.raw_message_id)
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
                       p.created_at, p.summary_title,
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

    def upsert_sync_job(self, source: str, instance: str = "",
                        group_id: str = "", group_name: str = "",
                        participants: int = 0,
                        status: str = "pending") -> int:
        existing = self.db.execute(
            "SELECT id, meta FROM source_sync_jobs WHERE source = ? AND group_id = ? LIMIT 1",
            (source, group_id)
        ).fetchone()
        now = datetime.utcnow().isoformat()
        meta = json.dumps({"participants": participants}) if participants else "{}"
        if existing:
            self.db.execute(
                """UPDATE source_sync_jobs
                   SET instance = ?, group_name = ?, meta = ?, status = ?, updated_at = ?
                   WHERE id = ?""",
                (instance, group_name, meta, status, now, existing["id"])
            )
            self._commit()
            return existing["id"]
        cur = self.db.execute(
            """INSERT INTO source_sync_jobs
               (source, instance, group_id, group_name, meta, status, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?)""",
            (source, instance, group_id, group_name, meta, status, now, now)
        )
        self._commit()
        return cur.lastrowid

    def prune_sync_jobs(self, source: str, instance: str,
                         keep_jids: set) -> int:
        if not keep_jids:
            return 0
        placeholders = ",".join("?" for _ in keep_jids)
        cur = self.db.execute(
            f"""DELETE FROM source_sync_jobs
               WHERE source = ?
               AND group_id NOT IN ({placeholders})""",
            [source] + list(keep_jids)
        )
        self._commit()
        return cur.rowcount

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
            "SELECT r.id, r.message, r.timestamp, r.group_name, r.sender, r.sender_phone, "
            "p.id AS parsed_id, p.intent, p.principal, p.broker_name, p.broker_phone, "
            "p.bhk, p.price, p.price_unit, p.area_sqft, "
            "p.building_name, p.landmark_name, p.micro_market, p.furnishing, p.location_raw, "
            "p.forwarded, p.profile_name, "
            "d.final_confidence, d.method "
            "FROM raw_messages r "
            "JOIN parsed_output p ON p.id = ("
            "  SELECT p2.id FROM parsed_output p2 "
            "  WHERE p2.raw_message_id = r.id "
            "    AND p2.intent IS NOT NULL "
            "    AND TRIM(p2.intent) != '' "
            "    AND UPPER(p2.intent) NOT IN ('TEXT', 'SOCIAL', 'UNKNOWN') "
            "  ORDER BY p2.confidence DESC, p2.id DESC LIMIT 1"
            ") "
            "LEFT JOIN resolver_decisions d ON d.parsed_id = p.id "
            "WHERE COALESCE(r.group_name, '') NOT LIKE '%@newsletter' "
            "  AND COALESCE(r.sender_jid, '') NOT LIKE '%@newsletter' "
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

    _ADJECTIVE_BLACKLIST = frozenset({
        "large", "small", "big", "huge", "tiny", "massive", "spacious",
        "compact", "cozy", "luxurious", "luxury", "beautiful", "lovely",
        "amazing", "wonderful", "fantastic", "gorgeous", "stunning",
        "premium", "exclusive", "superior", "deluxe", "standard",
        "modern", "contemporary", "classic", "elegant", "charming",
        "converted", "converted into", "converted to", "conversion",
        "combined", "combined into", "knocked", "merged", "jodi",
        "new", "old", "brand new", "newly", "ready", "ready to move",
        "semi", "fully", "unfurnished", "furnished",
        "higher", "lower", "front", "rear", "corner", "end",
        "road", "lane", "street", "avenue",
        "parking", "deck", "terrace", "balcony", "garden",
        "view", "sea view", "city view", "garden view", "pool view",
        "open", "vastu", "vastu compliant", "natural light",
        "available", "direct", "direct inventory", "inventory",
        "urgent", "urgently", "immediate", "immediate possession",
        "negotiable", "affordable", "budget", "value for money",
        "rare", "must see", "must visit",
        "independent", "separate", "private",
        "west", "north", "south", "facing",
        "upper", "lower", "ground", "top", "middle", "basement",
        "good", "great", "best", "super", "top", "fine",
        "special", "exclusive", "sole",
        "clear", "hindu", "union",
        "owner", "deal direct", "direct owner",
        "production", "glass", "facade",
        "experience", "lease", "production",
        "nana", "nani",
        "selling", "sale", "rent", "rental",
        "call", "contact", "details", "price", "rate", "cost",
        "total", "final", "net",
        "truck access", "easy truck access",
        "walking", "walkable",
        # Prepositions and functional words — noise when standalone
        "with", "without", "for", "to", "from", "of", "by", "at", "in", "on",
        "and", "or", "the", "a", "an", "is", "has", "have", "are", "was",
        "this", "that", "these", "those", "it", "its", "all", "each", "every",
        "being", "been", "just", "only", "also", "very", "too",
        "more", "less", "most", "least", "some", "any", "no", "not",
        "up", "down", "out", "off", "over", "under", "through", "across",
        "along", "around", "about", "between", "among", "before", "after",
    })

    def add_trainer_term(self, term: str, context: str = "", status: str = "pending", raw_message_id: int | None = None, force_trainer: bool = False) -> dict | None:
        """Add a term to the knowledge trainer queue.
        
        Returns {"term": ..., "status": ...} on success.
        Returns {"error": "blacklisted", "term": ...} if the term is a known non-entity.
        Returns {"status": "candidate", ...} if stored as a low-confidence learning candidate.
        
        Set force_trainer=True (e.g. from inline-resolve) to skip confidence routing
        and insert directly into the trainer table.
        """
        term = term.strip()
        if not term:
            return {"error": "empty_term"}
        import re
        term_lower = term.lower()
        term_words = term_lower.split()
        
        # Reject single-word adjectives and generic descriptors
        if len(term_words) == 1 and term_lower in self._ADJECTIVE_BLACKLIST:
            return {"error": "blacklisted", "term": term, "reason": "adjective"}
        
        # Reject if ALL words are blacklisted
        if term_words and all(w in self._ADJECTIVE_BLACKLIST for w in term_words):
            return {"error": "blacklisted", "term": term, "reason": "all_words_blacklisted"}
        
        # Score confidence based on structural signals
        confidence = 0.0
        has_capitalized = term[0].isupper() if term else False
        has_real_suffix = bool(re.search(
            r'(?:Bil|Bldg|Building|Apt|Complex|Tower|Heights|Park|Residency|'
            r'Enclave|Villa|Society|CHS|Housing|Apartment|Ivory|Residences?|'
            r'Nest|Abode|Haven|Vihar|Vatika|Quarters?)$',
            term, re.IGNORECASE
        ))
        if has_real_suffix:
            confidence += 0.4
        if has_capitalized:
            confidence += 0.2
        if len(term_words) >= 2:
            confidence += 0.15
        if len(term) >= 6:
            confidence += 0.1
        # Bonus for multi-word where ALL words are capitalized (proper name signal)
        if has_capitalized and len(term_words) >= 2 and all(w[0].isupper() for w in term_words if w):
            confidence += 0.2
        # Bonus for no blacklisted words at all (clean proper name)
        if term_words and not any(w in self._ADJECTIVE_BLACKLIST for w in term_words):
            confidence += 0.15
        
        # Low-confidence terms → learning candidates (not trainer)
        if not force_trainer and confidence < 0.6:
            try:
                self.db.execute("""
                    INSERT INTO knowledge_learning_candidates (phrase, frequency, contexts, raw_message_ids, confidence, source)
                    VALUES (?, 1, ?, ?, ?, 'scanner')
                    ON CONFLICT(phrase) DO UPDATE SET
                        frequency = frequency + 1,
                        last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                        confidence = MAX(confidence, ?),
                        contexts = ?
                """, (
                    term,
                    json.dumps([context[:200]] if context else []),
                    json.dumps([raw_message_id] if raw_message_id else []),
                    round(confidence, 2),
                    confidence,
                    json.dumps([context[:200]] if context else []),
                ))
                self.db.commit()
                return {"status": "candidate", "term": term, "confidence": round(confidence, 2)}
            except Exception as e:
                return {"error": str(e)}
        
        # High-confidence terms → knowledge trainer
        try:
            self.db.execute("""
                INSERT INTO knowledge_trainer (term, context, status, raw_message_id)
                VALUES (?, ?, ?, ?)
                ON CONFLICT(term) DO UPDATE SET
                    frequency = frequency + 1,
                    last_seen = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                    context = ?,
                    raw_message_id = COALESCE(?, raw_message_id)
            """, (term, context, status, raw_message_id, context, raw_message_id))
            self.db.commit()
            return {"term": term, "status": status, "confidence": round(confidence, 2)}
        except Exception as e:
            return {"error": str(e)}

    def get_trainer_terms(self, status: str | None = None, limit: int = 100) -> list[dict]:
        """Get terms from the knowledge trainer queue."""
        if status:
            rows = self.db.execute("""
                SELECT kt.id, kt.term, kt.context, kt.frequency,
                       kt.first_seen, kt.last_seen, kt.status,
                       kt.resolved_by, kt.resolved_at, kt.raw_message_id,
                       rm.message AS raw_message, kt.notes
                FROM knowledge_trainer kt
                LEFT JOIN raw_messages rm ON rm.id = kt.raw_message_id
                WHERE kt.status = ?
                ORDER BY kt.frequency DESC, kt.last_seen DESC
                LIMIT ?
            """, (status, limit)).fetchall()
        else:
            rows = self.db.execute("""
                SELECT kt.id, kt.term, kt.context, kt.frequency,
                       kt.first_seen, kt.last_seen, kt.status,
                       kt.resolved_by, kt.resolved_at, kt.raw_message_id,
                       rm.message AS raw_message, kt.notes
                FROM knowledge_trainer kt
                LEFT JOIN raw_messages rm ON rm.id = kt.raw_message_id
                ORDER BY kt.frequency DESC, kt.last_seen DESC
                LIMIT ?
            """, (limit,)).fetchall()

        return [
            {
                "id": r[0], "term": r[1], "context": r[2],
                "frequency": r[3], "first_seen": r[4], "last_seen": r[5],
                "status": r[6], "resolved_by": r[7], "resolved_at": r[8],
                "raw_message_id": r[9], "raw_message": r[10] or "",
                "notes": r[11] or "",
            }
            for r in rows
        ]

    def resolve_trainer_term(self, term_id: int, status: str, resolved_by: str = "user", notes: str = "", expands_to: list | None = None) -> bool:
        """Resolve a trainer term (mark as building, society, landmark, locality, combined_locality, etc.)."""
        try:
            row = self.db.execute(
                "SELECT term, raw_message_id FROM knowledge_trainer WHERE id = ?", (term_id,)
            ).fetchone()
            if not row:
                return False
            term = row[0]
            raw_msg_id = row[1]
            self.db.execute("""
                UPDATE knowledge_trainer
                SET status = ?, resolved_by = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now'),
                    notes = ?
                WHERE id = ?
            """, (status, resolved_by, notes, term_id))

            # Reject blacklisted terms — never create aliases for adjectives
            term_words = term.lower().split()
            if term_words and all(w in self._ADJECTIVE_BLACKLIST for w in term_words):
                return True  # Mark as resolved (ignored) without creating alias

            # Create knowledge alias for entity types so future parses recognize them
            if status in ("building", "society", "landmark", "locality", "combined_locality"):
                entity_type_map = {
                    "building": "building",
                    "society": "building",
                    "landmark": "landmark",
                    "locality": "market",
                    "combined_locality": "combined_locality",
                }
                canonical = term.strip()

                # Extract locality and price from the source message
                locality = ""
                price_min = 0.0
                price_max = 0.0
                if raw_msg_id:
                    msg_row = self.db.execute(
                        "SELECT message FROM raw_messages WHERE id = ?", (raw_msg_id,)
                    ).fetchone()
                    if msg_row:
                        msg = msg_row[0] or ""
                        price_pattern = re.compile(r'(\d+(?:\.\d+)?)\s*(cr|lac|lakh|k)\b', re.IGNORECASE)
                        price_matches = price_pattern.findall(msg)
                        if price_matches:
                            vals = []
                            for amt, unit in price_matches:
                                val = float(amt)
                                if unit.lower() in ("cr", "crore"):
                                    val *= 10000000
                                elif unit.lower() in ("lac", "lakh"):
                                    val *= 100000
                                elif unit.lower() == "k":
                                    val *= 1000
                                vals.append(val)
                            if vals:
                                price_min = min(vals)
                                price_max = max(vals)
                        known_localities = {"bandra", "andheri", "santacruz", "khar", "juhu", "goregaon", "malad", "worli", "powai", "bkc", "lokhandwala", "versova", "vile parle", "kurla", "ghatkopar", "mulund", "thane", "vashi", "nerul", "belapur", "kharghar", "wadala", "prabhadevi", "lower parel", "dadar", "mahim", "matunga", "sion", "kings circle", "byculla", "marine lines", "churchgate", "colaba", "cuffe parade", "walkeshwar", "malabar hill", "peddar road", "altamount road", "nepean sea road", "breach candy", "tardeo", "grant road", "mumbai central", "mahim", "pali hill", "mount mary", "bandstand", "chapel road", "turner road", "waterfield road", "linking road", "sv road", "marve road", "new link road", "oshiwara", "jogeshwari", "kandivali", "borivali", "dahisar", "mira road", "bhayandar", "vasai", "virar", "panvel", "kamothe", "new panvel", "ulwe", "ghansoli", "rabale", "airoli", "koparkhairane", "ghodbunder road", "kolshet road", "pokhran road", "hiranandani", "kasarvadavali", "manpada", "dombivili", "kalyan", "ambarnath", "badlapur", "karjat", "neral"}
                        msg_lower = msg.lower()
                        for loc in known_localities:
                            if loc in msg_lower:
                                locality = loc.title()
                                break

                try:
                    self.db.execute("""
                        INSERT OR IGNORE INTO knowledge_aliases (alias, canonical, entity_type, confidence, source, created_at, locality, price_min, price_max)
                        VALUES (?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'), ?, ?, ?)
                    """, (canonical.lower(), canonical, entity_type_map.get(status, "building"), 0.85, f"trainer:{resolved_by}", locality, price_min, price_max))
                    self.db.commit()
                except Exception:
                    pass

                # Gather and store aggregated intel from all messages mentioning this entity
                try:
                    intel = self._gather_entity_intel(canonical)
                    self.set_entity_intel(canonical.lower(), intel)
                except Exception:
                    pass

            # Combined locality: store expansion rule mapping surface phrase → multiple canonical localities
            if status == "combined_locality" and expands_to:
                import json
                surface = term.strip()
                try:
                    self.db.execute("""
                        INSERT OR REPLACE INTO combined_locality_rules (surface, expands_to, created_at)
                        VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
                    """, (surface.lower(), json.dumps(expands_to)))
                    self.db.commit()
                except Exception:
                    pass

                # Also create individual knowledge aliases for each expanded locality
                for loc in expands_to:
                    try:
                        self.db.execute("""
                            INSERT OR IGNORE INTO knowledge_aliases (alias, canonical, entity_type, confidence, source, created_at)
                            VALUES (?, ?, 'market', 0.85, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
                        """, (loc.lower(), loc, f"trainer:{resolved_by}"))
                    except Exception:
                        pass
                self.db.commit()

            return True
        except Exception:
            return False

    def ignore_trainer_term(self, term_id: int) -> bool:
        """Mark a trainer term as ignored."""
        return self.resolve_trainer_term(term_id, "ignored", "user")

    def _gather_entity_intel(self, canonical: str) -> dict:
        """Scans raw_messages and parsed_output for all mentions of an entity
        and returns aggregated intel (brokers, BHK range, price range, count, time span)."""
        import json
        intel: dict = {
            "message_count": 0,
            "first_seen": None,
            "last_seen": None,
            "broker_names": [],
            "broker_phones": [],
            "bhk_sizes": [],
            "price_min": 0.0,
            "price_max": 0.0,
            "localities": [],
            "parsed_count": 0,
        }
        term_lower = canonical.lower()
        # Build multiple search patterns — exact phrase + each word of the canonical
        patterns = [f"%{term_lower}%"]
        # Also match individual long words (>=5 chars) in case messages
        # only mention e.g. "Indiabulls" without the full "Sky Forest"
        # Skip common English words that would cause too many false positives
        _COMMON_WORDS = {"reliable", "business", "centre", "center", "building", "tower",
                         "office", "commercial", "properties", "property", "realty",
                         "realtor", "estate", "consultant", "advisor", "corner",
                         "square", "heights", "residency", "residential", "apartment",
                         "platinum", "golden", "royal", "prime", "premium", "luxury",
                         "grand", "elite", "supreme", "classic", "heritage",
                         "corporate", "space", "shop", "sale", "rent", "rental",
                         "floor", "ground", "first", "second", "third",
                         "furnished", "unfurnished", "carpet", "area", "price",
                         "contact", "call", "whatsapp", "available", "situated",
                         "located", "near", "opposite", "beside", "above",
                         "parking", "deposit", "negotiable", "immediate",
                         "possession", "amenities", "security", "backup"}
        for w in term_lower.split():
            if len(w) >= 5 and w not in _COMMON_WORDS:
                patterns.append(f"%{w}%")
        try:
            import re
            ids_seen: set[int] = set()
            rows = []
            for pat in patterns:
                for r in self.db.execute(
                    "SELECT id, message, timestamp FROM raw_messages WHERE LOWER(message) LIKE ? ORDER BY id",
                    (pat,),
                ).fetchall():
                    if r[0] not in ids_seen:
                        ids_seen.add(r[0])
                        rows.append(r)
            intel["message_count"] = len(rows)
            if rows:
                for r in rows:
                    mid, msg, ts = r
                    msg_lower = (msg or "").lower()
                    # BHK
                    for m in __import__("re").finditer(r"(\d+)\s*bhk", msg_lower):
                        b = int(m.group(1))
                        if b not in intel["bhk_sizes"]:
                            intel["bhk_sizes"].append(b)
                    # Price
                    for m in __import__("re").finditer(r"(\d+(?:\.\d+)?)\s*(cr|crore|lac|lakh|k)\b", msg_lower):
                        amt = float(m.group(1))
                        unit = m.group(2)
                        if unit in ("cr", "crore"):
                            amt *= 10000000
                        elif unit in ("lac", "lakh"):
                            amt *= 100000
                        elif unit == "k":
                            amt *= 1000
                        if intel["price_min"] == 0 or amt < intel["price_min"]:
                            intel["price_min"] = amt
                        if amt > intel["price_max"]:
                            intel["price_max"] = amt
                    # Phones
                    for m in __import__("re").finditer(r"(\d{10})", msg):
                        phone = m.group(1)
                        if phone not in intel["broker_phones"]:
                            intel["broker_phones"].append(phone)
                    # Time span
                    if ts:
                        if intel["first_seen"] is None or ts < intel["first_seen"]:
                            intel["first_seen"] = ts
                        if intel["last_seen"] is None or ts > intel["last_seen"]:
                            intel["last_seen"] = ts
                intel["bhk_sizes"].sort()
            # Broker names from raw_messages (simple heuristic: lines with phone-like text or 'properties'/'realtor')
            for r in rows:
                msg = r[1] or ""
                for line in msg.split("\n"):
                    line_stripped = line.strip()
                    if any(kw in line_stripped.lower() for kw in ("properties", "realtor", "realtors", "realty", "consultant")):
                        name = line_stripped.strip("*📞📱 ")
                        if name and len(name) > 2 and name not in intel["broker_names"]:
                            intel["broker_names"].append(name)
            # Localities from parsed_output
            known_localities = {"bandra", "andheri", "santacruz", "khar", "juhu", "goregaon", "malad", "worli", "powai", "bkc", "lokhandwala", "versova", "vile parle", "kurla", "ghatkopar", "mulund", "thane", "vashi", "nerul", "belapur", "kharghar", "wadala", "prabhadevi", "lower parel", "dadar", "mahim", "matunga", "sion", "kings circle", "byculla", "marine lines", "churchgate", "colaba", "cuffe parade", "walkeshwar", "malabar hill", "peddar road", "altamount road", "nepean sea road", "breach candy", "tardeo", "grant road", "mumbai central", "pali hill", "mount mary", "bandstand", "chapel road", "turner road", "waterfield road", "linking road", "sv road", "marve road", "new link road", "oshiwara", "jogeshwari", "kandivali", "borivali", "dahisar", "mira road", "bhayandar", "vasai", "virar", "panvel", "kamothe", "new panvel", "ulwe", "ghansoli", "rabale", "airoli", "koparkhairane", "ghodbunder road", "kolshet road", "pokhran road", "hiranandani", "kasarvadavali", "manpada", "dombivili", "kalyan", "ambarnath", "badlapur", "karjat", "neral"}
            seen_locs = set()
            for r in rows:
                msg_lower = (r[1] or "").lower()
                for loc in known_localities:
                    if loc in msg_lower and loc not in seen_locs:
                        seen_locs.add(loc)
                        intel["localities"].append(loc.title())
            # Params for the price filter: exclude obvious outliers (> 10x median)
            if intel["message_count"] > 0:
                # Count parsed_output matches
                try:
                    po = self.db.execute(
                        "SELECT COUNT(*) FROM parsed_output WHERE building_name LIKE ? OR landmark_name LIKE ?",
                        (f"%{canonical}%", f"%{canonical}%"),
                    ).fetchone()
                    if po:
                        intel["parsed_count"] = po[0]
                except Exception:
                    pass

            return intel
        except Exception:
            return intel

    def set_entity_intel(self, alias: str, intel: dict) -> bool:
        """Store aggregated intel JSON on the knowledge_aliases row for a given alias."""
        try:
            self.db.execute(
                "UPDATE knowledge_aliases SET intel = ? WHERE alias = ?",
                (json.dumps(intel, default=str), alias),
            )
            self.db.commit()
            return True
        except Exception:
            return False

    def get_entity_intel(self, alias: str) -> dict | None:
        """Retrieve aggregated intel for an entity alias."""
        try:
            row = self.db.execute(
                "SELECT intel FROM knowledge_aliases WHERE alias = ?", (alias.lower(),)
            ).fetchone()
            if row and row[0]:
                return json.loads(row[0])
            return None
        except Exception:
            return None

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
                       "facing", "neg", "lacs", "experience", "luxury", "brand", "new",
                       # Adjectives - never entities
                       "large", "small", "huge", "tiny", "spacious", "compact",
                       "luxurious", "beautiful", "lovely", "amazing", "stunning",
                       "converted", "conversion", "combined", "knocked", "merged",
                       "higher", "lower", "front", "rear", "corner", "end",
                       "lane", "street", "avenue", "deck", "terrace", "balcony",
                       "garden", "parking", "open", "vastu",
                       "immediate", "ready", "furnished", "unfurnished",
                       "semi", "fully", "direct", "urgent", "affordable",
                       "rare", "special", "exclusive", "private",
                       "east", "west", "north", "south", "facing",
                       "middle", "basement", "top", "ground",
                       "owner", "deal", "walking", "walkable",
                       "selling", "rental", "leasehold", "freehold",
                       "modular", "modern", "contemporary", "classic", "elegant",
                       "separate", "individual", "sole", "negotiable",
                       "prestigious", "prime", "good", "great"}

        # Amenities and marketing fluff — never real entity names
        amenity_words = {
            "easy truck access", "truck access", "direct inventory", "direct entry",
            "individual", "sea view", "city view", "garden view", "pool view",
            "open view", "natural light", "vastu compliant", "vastu", "corner",
            "end unit", "high floor", "low floor", "penthouse", "duplex",
            "renovated", "newly painted", "semi furnished", "fully furnished",
            "unfurnished", "brand new", "newly built", "under construction",
            "ready to move", "immediate possession", "negotiable", "nearest",
            "opposite", "behind", "beside", "near", "close to", "walking distance",
            "prime location", "premium location", "peaceful", "quiet", "serene",
            "spacious", "compact", "affordable", "budget", "value for money",
            "rare", "exclusive", "must see", "must visit", "owner", "deal direct",
        }

        # Sample raw messages — target recent unresolved resolver decisions first, fallback to random
        unresolved = self.db.execute("""
            SELECT rm.id, rm.message FROM resolver_decisions rd
            JOIN parsed_output p ON p.id = rd.parsed_id
            JOIN raw_messages rm ON rm.id = p.raw_message_id
            WHERE rd.method = 'unresolved'
            ORDER BY rd.id DESC
            LIMIT 200
        """).fetchall()

        if not unresolved:
            unresolved = self.db.execute("""
                SELECT id, message FROM raw_messages
                WHERE LENGTH(message) > 50
                ORDER BY RANDOM()
                LIMIT 200
            """).fetchall()

        # Extract potential building names
        term_freq = {}
        match_details = {}
        building_pattern = re.compile(r'\b([A-Z][a-z]{2,}(?:\s+[A-Z][a-z]{2,})*)\s+(?:Bil\.?|Bldg\.?|Building|Apt\.?|Complex|Tower|Heights?|Park|Residency|Enclave|Villa|Society|CHS|Housing|Apartment|Ivory|Residences?|Nest|Abode|Haven|Vihar|Vatika|Quarters?)\b', re.IGNORECASE)
        short_pattern = re.compile(r'\b([A-Z][a-z]{3,})\s+(?:Bil|Bldg|Bldg|Apt|CHS|Society|Tower|Heights)\b', re.IGNORECASE)

        for row in unresolved:
            msg = row[1] or ""
            msg_id = row[0]
            for match in building_pattern.finditer(msg):
                term = match.group(1).strip()
                term_lower = term.lower()

                if term_lower in known_buildings or term_lower in known_markets or term_lower in known_landmarks:
                    continue
                if len(term) < 3 or len(term) > 30:
                    continue
                if term_lower in stop_words:
                    continue
                if term_lower in amenity_words or any(aw in msg.lower() for aw in amenity_words):
                    continue
                if '\n' in term or '\r' in term:
                    continue
                if not term[0].isupper():
                    continue
                if "Tenant:" in msg[:msg.find(term)]:
                    continue
                if "Pvt. Ltd." in msg[msg.find(term):msg.find(term)+80] or " LLP" in term or " Ltd" in term:
                    continue

                if term not in term_freq:
                    term_freq[term] = 0
                    match_details[term] = {"contexts": [], "raw_ids": []}
                term_freq[term] += 1
                if len(match_details[term]["contexts"]) < 3:
                    match_details[term]["contexts"].append(msg[:120])
                    match_details[term]["raw_ids"].append(msg_id)

        sorted_terms = sorted(term_freq.items(), key=lambda x: x[1], reverse=True)
        results = []
        for term, freq in sorted_terms:
            if freq < 2:
                continue
            if len(results) >= limit:
                break
            details = match_details[term]
            results.append({
                "term": term,
                "frequency": freq,
                "contexts": details["contexts"],
                "raw_ids": details["raw_ids"],
                "already_in_trainer": self.db.execute(
                    "SELECT id FROM knowledge_trainer WHERE term = ?", (term,)
                ).fetchone() is not None,
            })
        return results


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
                            confidence: float = 1.0, source: str = "system",
                            locality: str = "", price_min: float = 0, price_max: float = 0) -> bool:
        """Add an alias mapping."""
        try:
            self.db.execute("""
                INSERT OR REPLACE INTO knowledge_aliases (alias, canonical, entity_type, confidence, source, locality, price_min, price_max)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """, (alias.lower().strip(), canonical, entity_type, confidence, source, locality, price_min, price_max))
            self.db.commit()
            return True
        except Exception:
            return False

    def resolve_alias(self, term: str, entity_type: str | None = None, locality: str | None = None) -> dict | None:
        """Resolve a term to its canonical form via aliases. Returns canonical, locality, price range."""
        term_lower = term.lower().strip()
        if entity_type:
            row = self.db.execute(
                "SELECT canonical, locality, price_min, price_max FROM knowledge_aliases WHERE alias = ? AND entity_type = ?",
                (term_lower, entity_type)
            ).fetchone()
        else:
            row = self.db.execute(
                "SELECT canonical, locality, price_min, price_max FROM knowledge_aliases WHERE alias = ?",
                (term_lower,)
            ).fetchone()
        if row:
            return {"canonical": row[0], "locality": row[1] or "", "price_min": row[2] or 0, "price_max": row[3] or 0}
        return None

    def search_knowledge_records(self, query: str, limit: int = 20,
                                  content_type: str | None = None,
                                  sender_jid: str | None = None,
                                  conversation_id: str | None = None) -> list[dict]:
        """Search knowledge records using FTS5."""
        try:
            # Try FTS5 first
            where_clauses = [
                "kr.is_valid = 1",
                "COALESCE(kr.conversation_id, '') NOT LIKE '%@newsletter'",
                "COALESCE(kr.conversation_name, '') NOT LIKE '%@newsletter'",
                "COALESCE(kr.sender_jid, '') NOT LIKE '%@newsletter'",
                "COALESCE(kr.conversation_id, '') NOT IN ('status@broadcast', 'broadcast')",
                "COALESCE(kr.conversation_id, '') NOT LIKE '%@broadcast'",
            ]
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
                WHERE raw_content LIKE ?
                  AND is_valid = 1
                  AND COALESCE(conversation_id, '') NOT LIKE '%@newsletter'
                  AND COALESCE(conversation_name, '') NOT LIKE '%@newsletter'
                  AND COALESCE(sender_jid, '') NOT LIKE '%@newsletter'
                  AND COALESCE(conversation_id, '') NOT IN ('status@broadcast', 'broadcast')
                  AND COALESCE(conversation_id, '') NOT LIKE '%@broadcast'
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
              AND COALESCE(conversation_id, '') NOT LIKE '%@newsletter'
              AND COALESCE(conversation_name, '') NOT LIKE '%@newsletter'
              AND COALESCE(sender_jid, '') NOT LIKE '%@newsletter'
              AND COALESCE(conversation_id, '') NOT IN ('status@broadcast', 'broadcast')
              AND COALESCE(conversation_id, '') NOT LIKE '%@broadcast'
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

    def get_unit_aliases(self) -> dict[str, str]:
        """Get all price unit aliases as {alias: canonical_unit}."""
        rows = self.db.execute("SELECT alias, canonical_unit FROM price_unit_aliases").fetchall()
        return {r[0]: r[1] for r in rows}

    def add_unit_alias(self, alias: str, canonical_unit: str) -> bool:
        """Add a price unit alias."""
        try:
            self.db.execute(
                "INSERT OR IGNORE INTO price_unit_aliases (alias, canonical_unit) VALUES (?, ?)",
                (alias.lower().strip(), canonical_unit)
            )
            self.db.commit()
            return True
        except Exception:
            return False

    def resolve_unit_alias(self, unit: str) -> str:
        """Resolve a unit alias to its canonical form."""
        if not unit:
            return "abs"
        alias = unit.lower().strip()
        # Check database first
        row = self.db.execute(
            "SELECT canonical_unit FROM price_unit_aliases WHERE alias = ?", (alias,)
        ).fetchone()
        if row:
            return row[0]
        # Fallback to hardcoded
        normalized = _normalize_price(1, unit)
        if normalized == 1_00_000:
            return "L"
        elif normalized == 1_00_00_000:
            return "Cr"
        elif normalized == 1_000:
            return "K"
        return "abs"

    def seed_unit_aliases(self):
        """Seed common price unit aliases."""
        aliases = {
            # Lakhs
            "l": "L", "lac": "L", "lacs": "L", "lakh": "L", "lakhs": "L",
            "lac": "L", "lk": "L", "lac": "L", "lac": "L",
            # Crores
            "cr": "Cr", "crore": "Cr", "crores": "Cr", "karod": "Cr",
            "karods": "Cr", "kror": "Cr", "cror": "Cr",
            # Thousands
            "k": "K", "thousand": "K", "thousands": "K", "hazaar": "K",
            "000": "K",
            # Absolute
            "abs": "abs", "absolute": "abs", "rs": "abs", "rupees": "abs",
            "inr": "abs", "₹": "abs",
        }
        for alias, canonical in aliases.items():
            self.add_unit_alias(alias, canonical)

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

    # ── Workspace / Team Management ──────────────────────────

    PERMISSION_LABELS = [
        ("view_inbox", "View Market Inbox"),
        ("reply_whatsapp", "Reply from WhatsApp"),
        ("save_requirements", "Save Requirements"),
        ("save_listings", "Save Listings"),
        ("export_contacts", "Export Contacts"),
        ("view_broker_numbers", "View Broker Numbers"),
        ("add_team_members", "Add Team Members"),
        ("delete_data", "Delete Data"),
        ("ai_actions", "AI Actions"),
        ("bulk_broadcast", "Bulk Broadcast"),
    ]

    def _perm_bitfield(self, keys: list[str]) -> int:
        labels = [k for k, _ in self.PERMISSION_LABELS]
        return sum(1 << i for i, k in enumerate(labels) if k in keys)

    def _perm_keys(self, bitfield: int) -> list[str]:
        labels = [k for k, _ in self.PERMISSION_LABELS]
        return [labels[i] for i in range(len(labels)) if bitfield & (1 << i)]

    def list_team_members(self) -> list[dict]:
        rows = self.db.execute(
            "SELECT * FROM team_members ORDER BY role = 'owner' DESC, name ASC"
        ).fetchall()
        return [dict(r) for r in rows]

    def get_team_member(self, member_id: int) -> dict | None:
        row = self.db.execute(
            "SELECT * FROM team_members WHERE id = ?", (member_id,)
        ).fetchone()
        return dict(row) if row else None

    def create_team_member(self, name: str, email: str = "", phone: str = "",
                           role: str = "member", permission_keys: list[str] | None = None,
                           linked_broker_phone: str | None = None) -> dict:
        permissions = self._perm_bitfield(permission_keys or [])
        email_val = email.strip() if email.strip() else None
        phone_val = phone.strip() if phone.strip() else None
        cur = self.db.execute(
            """INSERT INTO team_members (name, email, phone, role, permissions, linked_broker_phone)
               VALUES (?,?,?,?,?,?)""",
            (name.strip(), email_val, phone_val, role, permissions, linked_broker_phone)
        )
        self._commit()
        return self.get_team_member(cur.lastrowid) or {}

    def update_team_member(self, member_id: int, **kwargs) -> dict | None:
        member = self.get_team_member(member_id)
        if not member:
            return None
        fields = {}
        for k in ("name", "email", "phone", "role", "linked_broker_phone"):
            v = kwargs.get(k)
            if v is not None:
                fields[k] = v.strip() if isinstance(v, str) else v
        if "permission_keys" in kwargs:
            fields["permissions"] = self._perm_bitfield(kwargs["permission_keys"])
        if "is_active" in kwargs:
            fields["is_active"] = 1 if kwargs["is_active"] else 0
        if not fields:
            return member
        set_clause = ", ".join(f"{k} = ?" for k in fields)
        fields["updated_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        set_clause += ", updated_at = ?"
        vals = list(fields.values()) + [member_id]
        self.db.execute(f"UPDATE team_members SET {set_clause} WHERE id = ?", vals)
        self._commit()
        return self.get_team_member(member_id)

    def deactivate_team_member(self, member_id: int) -> bool:
        self.db.execute(
            "UPDATE team_members SET is_active = 0, updated_at = ? WHERE id = ?",
            (datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), member_id)
        )
        self._commit()
        return True

    def log_activity(self, team_member_id: int, action: str,
                     target_type: str = "", target_id: str = "",
                     details: dict | None = None, ip_address: str = "") -> int:
        cur = self.db.execute(
            """INSERT INTO activity_log (team_member_id, action, target_type, target_id, details, ip_address)
               VALUES (?,?,?,?,?,?)""",
            (team_member_id, action, target_type, target_id,
             json.dumps(details or {}), ip_address)
        )
        self._commit()
        return cur.lastrowid

    def list_activity(self, limit: int = 50, offset: int = 0,
                      action: str | None = None,
                      team_member_id: int | None = None) -> list[dict]:
        clauses = []
        params: list = []
        if action:
            clauses.append("a.action = ?")
            params.append(action)
        if team_member_id:
            clauses.append("a.team_member_id = ?")
            params.append(team_member_id)
        where = ("WHERE " + " AND ".join(clauses)) if clauses else ""
        rows = self.db.execute(
            f"""SELECT a.*, t.name AS member_name, t.role AS member_role
                FROM activity_log a
                LEFT JOIN team_members t ON t.id = a.team_member_id
                {where}
                ORDER BY a.created_at DESC
                LIMIT ? OFFSET ?""",
            params + [limit, offset]
        ).fetchall()
        return [dict(r) for r in rows]

    def list_whatsapp_access(self) -> list[dict]:
        rows = self.db.execute(
            """SELECT wa.*, t.name AS member_name, t.role AS member_role
               FROM team_member_whatsapp_access wa
               JOIN team_members t ON t.id = wa.team_member_id
               ORDER BY t.name"""
        ).fetchall()
        return [dict(r) for r in rows]

    def set_whatsapp_access(self, team_member_id: int, whatsapp_number: str,
                            can_send: bool = False, can_view_messages: bool = True) -> dict:
        self.db.execute(
            """INSERT INTO team_member_whatsapp_access (team_member_id, whatsapp_number, can_send, can_view_messages)
               VALUES (?,?,?,?)
               ON CONFLICT(team_member_id, whatsapp_number)
               DO UPDATE SET can_send = excluded.can_send, can_view_messages = excluded.can_view_messages""",
            (team_member_id, whatsapp_number, 1 if can_send else 0, 1 if can_view_messages else 0)
        )
        self._commit()
        row = self.db.execute(
            "SELECT * FROM team_member_whatsapp_access WHERE team_member_id = ? AND whatsapp_number = ?",
            (team_member_id, whatsapp_number)
        ).fetchone()
        return dict(row) if row else {}

    def get_chat_assignment(self, whatsapp_number: str, remote_jid: str) -> dict | None:
        row = self.db.execute(
            """SELECT ca.*, t.name AS assigned_name, tover.name AS taken_over_by_name
               FROM chat_assignments ca
               LEFT JOIN team_members t ON t.id = ca.assigned_to
               LEFT JOIN team_members tover ON tover.id = ca.taken_over_by
               WHERE ca.whatsapp_number = ? AND ca.remote_jid = ?""",
            (whatsapp_number, remote_jid)
        ).fetchone()
        return dict(row) if row else None

    def assign_chat(self, whatsapp_number: str, remote_jid: str,
                    team_member_id: int) -> dict:
        self.db.execute(
            """INSERT INTO chat_assignments (whatsapp_number, remote_jid, assigned_to)
               VALUES (?,?,?)
               ON CONFLICT(whatsapp_number, remote_jid)
               DO UPDATE SET assigned_to = excluded.assigned_to,
                             taken_over_by = NULL,
                             taken_over_at = NULL,
                             released_at = NULL""",
            (whatsapp_number, remote_jid, team_member_id)
        )
        self._commit()
        return self.get_chat_assignment(whatsapp_number, remote_jid) or {}

    def take_over_chat(self, whatsapp_number: str, remote_jid: str,
                       team_member_id: int) -> dict:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.db.execute(
            """INSERT INTO chat_assignments (whatsapp_number, remote_jid, assigned_to, taken_over_by, taken_over_at)
               VALUES (?,?,NULL,?,?)
               ON CONFLICT(whatsapp_number, remote_jid)
               DO UPDATE SET taken_over_by = excluded.taken_over_by,
                             taken_over_at = excluded.taken_over_at,
                             released_at = NULL""",
            (whatsapp_number, remote_jid, team_member_id, now)
        )
        self._commit()
        return self.get_chat_assignment(whatsapp_number, remote_jid) or {}

    def release_chat(self, whatsapp_number: str, remote_jid: str) -> dict | None:
        now = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.db.execute(
            """UPDATE chat_assignments
               SET released_at = ?, taken_over_by = NULL, taken_over_at = NULL
               WHERE whatsapp_number = ? AND remote_jid = ?""",
            (now, whatsapp_number, remote_jid)
        )
        self._commit()
        return self.get_chat_assignment(whatsapp_number, remote_jid)

    # ── Saved Inbox Views ────────────────────────────────────────

    def get_saved_inbox_views(self) -> list[dict]:
        rows = self.db.execute(
            "SELECT id, slug, name, description, filters, is_default, is_shared, created_at, updated_at "
            "FROM saved_inbox_views ORDER BY is_default DESC, name ASC"
        ).fetchall()
        return [dict(r) for r in rows]

    def get_saved_inbox_view(self, slug: str) -> dict | None:
        row = self.db.execute(
            "SELECT id, slug, name, description, filters, is_default, is_shared, created_at, updated_at "
            "FROM saved_inbox_views WHERE slug = ?", (slug,)
        ).fetchone()
        return dict(row) if row else None

    def create_saved_inbox_view(self, slug: str, name: str, filters: dict,
                                 description: str = "", is_default: bool = False,
                                 is_shared: bool = False) -> int:
        import json
        cur = self.db.execute(
            """INSERT INTO saved_inbox_views
               (slug, name, description, filters, is_default, is_shared)
               VALUES (?,?,?,?,?,?)""",
            (slug, name, description, json.dumps(filters), int(is_default), int(is_shared))
        )
        self.db.commit()
        return cur.lastrowid

    def update_saved_inbox_view(self, slug: str, name: str = None, filters: dict = None,
                                 description: str = None, is_default: bool = None,
                                 is_shared: bool = None) -> bool:
        import json
        sets = []
        params = []
        if name is not None:
            sets.append("name = ?")
            params.append(name)
        if filters is not None:
            sets.append("filters = ?")
            params.append(json.dumps(filters))
        if description is not None:
            sets.append("description = ?")
            params.append(description)
        if is_default is not None:
            sets.append("is_default = ?")
            params.append(int(is_default))
        if is_shared is not None:
            sets.append("is_shared = ?")
            params.append(int(is_shared))
        if not sets:
            return False
        sets.append("updated_at = datetime('now')")
        params.append(slug)
        self.db.execute(
            f"UPDATE saved_inbox_views SET {', '.join(sets)} WHERE slug = ?", params
        )
        self.db.commit()
        return True

    def delete_saved_inbox_view(self, slug: str) -> bool:
        cur = self.db.execute(
            "DELETE FROM saved_inbox_views WHERE slug = ?", (slug,)
        )
        self.db.commit()
        return cur.rowcount > 0


def _parse_bhk(bhk_str: str) -> int | None:
    """Parse '2 BHK', '3 BHK', '1RK' etc. to number."""
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


# ═══════════════════════════════════════════════════════════════════════
# Client Management
# ═══════════════════════════════════════════════════════════════════════

def _init_client_tables(db):
    """Create client management tables if they don't exist."""
    schema_path = Path(__file__).parent.parent / "schema_clients.sql"
    if schema_path.exists():
        db.executescript(schema_path.read_text())
    for column, definition in {
        "source_timestamp": "TEXT",
        "availability_status": "TEXT DEFAULT 'unknown'",
        "availability_checked_at": "TEXT",
        "last_offered_at": "TEXT",
    }.items():
        try:
            db.execute(f"ALTER TABLE client_property_candidates ADD COLUMN {column} {definition}")
        except sqlite3.OperationalError as exc:
            if "duplicate column name" not in str(exc).lower():
                raise


class ClientStorage:
    """Client management storage methods mixed into SqliteStorage."""

    def __init__(self):
        # Will be called after __init__ in SqliteStorage
        pass

    def ensure_client_tables(self):
        _init_client_tables(self.db)

    def _normalize_client_alias(self, value: str = "") -> str:
        normalized = (value or "").strip().lower()
        normalized = re.sub(r"[^a-z0-9]+", " ", normalized)
        return re.sub(r"\s+", " ", normalized).strip()

    # ── Clients ───────────────────────────────────────────────────────

    def create_client(self, name: str, phone: str = None, email: str = None, notes: str = "") -> int:
        self.ensure_client_tables()
        cur = self.db.execute(
            "INSERT INTO clients (name, phone, email, notes) VALUES (?, ?, ?, ?)",
            (name.strip(), phone, email, notes)
        )
        client_id = cur.lastrowid
        self.add_client_alias(client_id, name, source="client_name", confidence=1.0, commit=False)
        first_name = (name.strip().split() or [""])[0]
        if first_name and first_name.lower() != name.strip().lower():
            self.add_client_alias(client_id, first_name, source="client_first_name", confidence=0.92, commit=False)
        if phone:
            self.add_client_alias(client_id, phone, source="client_phone", confidence=1.0, commit=False)
        self.db.commit()
        return client_id

    def get_client(self, client_id: int) -> dict | None:
        row = self.db.execute("SELECT * FROM clients WHERE id = ?", (client_id,)).fetchone()
        if not row:
            return None
        return dict(row)

    def search_clients(self, query: str = "", limit: int = 20) -> list[dict]:
        if query:
            rows = self.db.execute(
                "SELECT * FROM clients WHERE name LIKE ? OR phone LIKE ? ORDER BY updated_at DESC LIMIT ?",
                (f"%{query}%", f"%{query}%", limit)
            ).fetchall()
        else:
            rows = self.db.execute(
                "SELECT * FROM clients ORDER BY updated_at DESC LIMIT ?", (limit,)
            ).fetchall()
        return [dict(r) for r in rows]

    def update_client(self, client_id: int, **kwargs) -> bool:
        allowed = {"name", "phone", "email", "notes", "status"}
        updates = {k: v for k, v in kwargs.items() if k in allowed}
        if not updates:
            return False
        sets = ", ".join(f"{k} = ?" for k in updates)
        vals = list(updates.values()) + [client_id]
        self.db.execute(f"UPDATE clients SET {sets}, updated_at = datetime('now') WHERE id = ?", vals)
        if "name" in updates:
            updated_name = str(updates["name"])
            self.add_client_alias(client_id, updated_name, source="client_name", confidence=1.0, commit=False)
            first_name = (updated_name.strip().split() or [""])[0]
            if first_name and first_name.lower() != updated_name.strip().lower():
                self.add_client_alias(client_id, first_name, source="client_first_name", confidence=0.92, commit=False)
        if "phone" in updates and updates["phone"]:
            self.add_client_alias(client_id, str(updates["phone"]), source="client_phone", confidence=1.0, commit=False)
        self.db.commit()
        return True

    # ── Client Aliases / Memory Resolution ────────────────────────────

    def add_client_alias(self, client_id: int, alias: str, source: str = "manual",
                         confidence: float = 1.0, commit: bool = True) -> int | None:
        self.ensure_client_tables()
        alias = (alias or "").strip()
        normalized = self._normalize_client_alias(alias)
        if not alias or not normalized:
            return None
        existing = self.db.execute(
            "SELECT id, client_id FROM client_aliases WHERE normalized_alias = ?",
            (normalized,),
        ).fetchone()
        if existing:
            if int(existing["client_id"]) == int(client_id):
                return existing["id"]
            return None
        cur = self.db.execute(
            """INSERT INTO client_aliases (client_id, alias, normalized_alias, source, confidence)
               VALUES (?, ?, ?, ?, ?)""",
            (client_id, alias, normalized, source, confidence),
        )
        if commit:
            self.db.commit()
        return cur.lastrowid

    def get_client_aliases(self, client_id: int) -> list[dict]:
        self.ensure_client_tables()
        rows = self.db.execute(
            "SELECT * FROM client_aliases WHERE client_id = ? ORDER BY confidence DESC, created_at DESC",
            (client_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    def resolve_client(self, query: str, min_score: float = 0.74) -> dict | None:
        self.ensure_client_tables()
        query = (query or "").strip()
        normalized = self._normalize_client_alias(query)
        if not normalized:
            return None

        row = self.db.execute(
            """SELECT c.*, ca.alias AS matched_alias, 1.0 AS match_score, 'alias_exact' AS match_method
               FROM client_aliases ca
               JOIN clients c ON c.id = ca.client_id
               WHERE ca.normalized_alias = ?
               LIMIT 1""",
            (normalized,),
        ).fetchone()
        if row:
            return dict(row)

        row = self.db.execute(
            """SELECT *, name AS matched_alias, 1.0 AS match_score, 'name_exact' AS match_method
               FROM clients
               WHERE lower(name) = lower(?) OR phone = ?
               LIMIT 1""",
            (query, query),
        ).fetchone()
        if row:
            return dict(row)

        candidates = self.db.execute(
            """SELECT c.*, ca.alias AS matched_alias, ca.normalized_alias, ca.confidence
               FROM client_aliases ca
               JOIN clients c ON c.id = ca.client_id
               WHERE c.status = 'active'
               UNION ALL
               SELECT c.*, c.name AS matched_alias, lower(c.name) AS normalized_alias, 1.0 AS confidence
               FROM clients c
               WHERE c.status = 'active'""",
        ).fetchall()
        best: dict | None = None
        best_score = 0.0
        compact_query = normalized.replace(" ", "")
        for candidate in candidates:
            cand = dict(candidate)
            cand_norm = self._normalize_client_alias(cand.get("matched_alias") or cand.get("name") or "")
            if not cand_norm:
                continue
            score = max(
                SequenceMatcher(None, normalized, cand_norm).ratio(),
                SequenceMatcher(None, compact_query, cand_norm.replace(" ", "")).ratio(),
            )
            if normalized in cand_norm or cand_norm in normalized:
                score = max(score, 0.88)
            score *= float(cand.get("confidence") or 1.0)
            if score > best_score:
                best_score = score
                best = cand

        if best and best_score >= min_score:
            best["match_score"] = round(best_score, 3)
            best["match_method"] = "fuzzy_alias"
            return best
        return None

    # ── Client Notes ─────────────────────────────────────────────────

    def add_client_note(self, client_id: int, body: str, note_type: str = "note",
                        source_text: str = "", source_jid: str = "",
                        source_message_id: str = "", confidence: float = 1.0,
                        supersedes_note_id: int | None = None) -> int:
        self.ensure_client_tables()
        if supersedes_note_id:
            self.db.execute(
                "UPDATE client_notes SET is_active = 0, updated_at = datetime('now') WHERE id = ? AND client_id = ?",
                (supersedes_note_id, client_id),
            )
        cur = self.db.execute(
            """INSERT INTO client_notes
               (client_id, note_type, body, source_text, source_jid, source_message_id,
                confidence, supersedes_note_id)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
            (client_id, note_type, body.strip(), source_text, source_jid,
             source_message_id, confidence, supersedes_note_id),
        )
        self.db.commit()
        return cur.lastrowid

    def get_client_notes(self, client_id: int, active_only: bool = True, limit: int = 100) -> list[dict]:
        self.ensure_client_tables()
        where = "client_id = ?"
        params: list = [client_id]
        if active_only:
            where += " AND is_active = 1"
        rows = self.db.execute(
            f"""SELECT * FROM client_notes
                WHERE {where}
                ORDER BY datetime(created_at) DESC, id DESC
                LIMIT ?""",
            (*params, limit),
        ).fetchall()
        return [dict(r) for r in rows]

    def get_latest_client_note(self, client_id: int) -> dict | None:
        self.ensure_client_tables()
        row = self.db.execute(
            """SELECT * FROM client_notes
               WHERE client_id = ? AND is_active = 1
               ORDER BY datetime(created_at) DESC, id DESC
               LIMIT 1""",
            (client_id,),
        ).fetchone()
        return dict(row) if row else None

    def update_client_note(self, note_id: int, body: str, note_type: str | None = None,
                           is_active: int | None = None) -> bool:
        self.ensure_client_tables()
        updates: dict = {"body": body.strip()}
        if note_type:
            updates["note_type"] = note_type
        if is_active is not None:
            updates["is_active"] = int(is_active)
        sets = ", ".join(f"{key} = ?" for key in updates)
        values = list(updates.values()) + [note_id]
        self.db.execute(
            f"UPDATE client_notes SET {sets}, updated_at = datetime('now') WHERE id = ?",
            values,
        )
        self.db.commit()
        return True

    # ── Client Requirements ───────────────────────────────────────────

    def add_client_requirement(self, client_id: int, intent: str, bhk: str = None,
                                price_min: float = None, price_max: float = None,
                                micro_market: str = None, building_name: str = None,
                                area_sqft_min: float = None, area_sqft_max: float = None,
                                furnishing: str = None, use_type: str = None,
                                notes: str = "", is_primary: int = 1) -> int:
        self.ensure_client_tables()
        cur = self.db.execute(
            """INSERT INTO client_requirements
               (client_id, intent, bhk, price_min, price_max, micro_market, building_name,
                area_sqft_min, area_sqft_max, furnishing, use_type, notes, is_primary)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (client_id, intent, bhk, price_min, price_max, micro_market, building_name,
             area_sqft_min, area_sqft_max, furnishing, use_type, notes, is_primary)
        )
        self.db.commit()
        return cur.lastrowid

    def get_client_requirements(self, client_id: int) -> list[dict]:
        rows = self.db.execute(
            "SELECT * FROM client_requirements WHERE client_id = ? ORDER BY is_primary DESC", (client_id,)
        ).fetchall()
        return [dict(r) for r in rows]

    def get_all_active_requirements(self) -> list[dict]:
        """Get all requirements from active clients for matching."""
        self.ensure_client_tables()
        rows = self.db.execute("""
            SELECT cr.*, c.name as client_name, c.phone as client_phone
            FROM client_requirements cr
            JOIN clients c ON cr.client_id = c.id
            WHERE c.status = 'active'
            ORDER BY cr.is_primary DESC
        """).fetchall()
        return [dict(r) for r in rows]

    def get_all_active_candidates(self, status: str = None, limit: int = 200) -> list[dict]:
        """Get saved inventory candidates across active clients."""
        self.ensure_client_tables()
        query = """
            SELECT cpc.*, c.name as client_name, c.phone as client_phone
            FROM client_property_candidates cpc
            JOIN clients c ON cpc.client_id = c.id
            WHERE c.status = 'active'
        """
        params: list = []
        if status:
            query += " AND cpc.status = ?"
            params.append(status)
        query += " ORDER BY cpc.confidence DESC, cpc.created_at DESC LIMIT ?"
        params.append(limit)
        rows = self.db.execute(query, params).fetchall()
        return [dict(r) for r in rows]

    # ── Client Property Candidates ────────────────────────────────────

    def add_property_candidate(self, client_id: int, listing_id: int = None,
                                 message_id: int = None, building_name: str = None,
                                 micro_market: str = None, bhk: str = None,
                                 price: float = None, price_unit: str = None,
                                 area_sqft: float = None, furnishing: str = None,
                                 confidence: float = 0.0, match_breakdown: dict = None,
                                 source_text: str = "", notes: str = "",
                                 source_timestamp: str = None,
                                 availability_status: str = "unknown") -> int | None:
        self.ensure_client_tables()
        # Check for duplicate
        if listing_id:
            existing = self.db.execute(
                "SELECT id FROM client_property_candidates WHERE client_id = ? AND listing_id = ?",
                (client_id, listing_id)
            ).fetchone()
            if existing:
                return None  # Already added

        cur = self.db.execute(
            """INSERT INTO client_property_candidates
               (client_id, listing_id, message_id, building_name, micro_market, bhk,
                price, price_unit, area_sqft, furnishing, confidence, match_breakdown,
                source_text, notes, source_timestamp, availability_status)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (client_id, listing_id, message_id, building_name, micro_market, bhk,
             price, price_unit, area_sqft, furnishing, confidence,
             json.dumps(match_breakdown or {}), source_text, notes,
             source_timestamp, availability_status or "unknown")
        )
        self.db.commit()
        return cur.lastrowid

    def get_client_candidates(self, client_id: int, status: str = None) -> list[dict]:
        q = "SELECT * FROM client_property_candidates WHERE client_id = ?"
        params = [client_id]
        if status:
            q += " AND status = ?"
            params.append(status)
        q += " ORDER BY confidence DESC, created_at DESC"
        rows = self.db.execute(q, params).fetchall()
        return [dict(r) for r in rows]

    def update_candidate_status(self, candidate_id: int, status: str) -> bool:
        extra = ", last_offered_at = datetime('now')" if status == "offered" else ""
        self.db.execute(
            f"UPDATE client_property_candidates SET status = ?{extra} WHERE id = ?",
            (status, candidate_id)
        )
        self.db.commit()
        return True

    def update_candidate_availability(self, candidate_id: int, availability_status: str,
                                      checked_at: str | None = None) -> bool:
        self.ensure_client_tables()
        self.db.execute(
            """UPDATE client_property_candidates
               SET availability_status = ?, availability_checked_at = COALESCE(?, datetime('now'))
               WHERE id = ?""",
            (availability_status, checked_at, candidate_id),
        )
        self.db.commit()
        return True

    def estimate_candidate_availability(self, candidate: dict) -> dict:
        status = str(candidate.get("availability_status") or "unknown").lower()
        if status == "confirmed_available":
            base = 0.96
        elif status == "likely_available":
            base = 0.78
        elif status in {"unavailable", "stale"}:
            base = 0.0 if status == "unavailable" else 0.18
        else:
            base = 0.62

        source_ts = candidate.get("source_timestamp") or candidate.get("created_at")
        age_days = None
        try:
            parsed = datetime.fromisoformat(str(source_ts).replace("Z", "+00:00"))
            if parsed.tzinfo is None:
                parsed = parsed.replace(tzinfo=timezone.utc)
            age_days = max(0, (datetime.now(timezone.utc) - parsed).days)
        except Exception:
            age_days = None

        if age_days is not None and status not in {"confirmed_available", "unavailable"}:
            if age_days <= 2:
                age_factor = 1.0
            elif age_days <= 7:
                age_factor = 0.82
            elif age_days <= 14:
                age_factor = 0.55
            elif age_days <= 30:
                age_factor = 0.32
            else:
                age_factor = 0.15
            base *= age_factor

        candidate_status = str(candidate.get("status") or "").lower()
        if candidate_status == "rejected":
            base *= 0.25
        elif candidate_status == "offered":
            base *= 0.9

        score = max(0.0, min(1.0, base))
        if score >= 0.8:
            label = "high"
        elif score >= 0.5:
            label = "medium"
        elif score > 0:
            label = "low"
        else:
            label = "unavailable"
        return {"score": round(score, 2), "label": label, "age_days": age_days, "status": status}

    # ── Follow-ups ────────────────────────────────────────────────────

    def create_follow_up(self, client_id: int = None, message_id: int = None,
                          building_name: str = None, broker_phone: str = None,
                          follow_up_type: str = "call", title: str = "",
                          notes: str = "", due_date: str = "", due_time: str = None) -> int:
        self.ensure_client_tables()
        cur = self.db.execute(
            """INSERT INTO follow_ups
               (client_id, message_id, building_name, broker_phone, follow_up_type,
                title, notes, due_date, due_time)
               VALUES (?,?,?,?,?,?,?,?,?)""",
            (client_id, message_id, building_name, broker_phone, follow_up_type,
             title, notes, due_date, due_time)
        )
        self.db.commit()
        return cur.lastrowid

    def get_follow_ups(self, client_id: int = None, status: str = "pending") -> list[dict]:
        q = "SELECT * FROM follow_ups WHERE status = ?"
        params = [status]
        if client_id:
            q += " AND client_id = ?"
            params.append(client_id)
        q += " ORDER BY due_date ASC"
        rows = self.db.execute(q, params).fetchall()
        return [dict(r) for r in rows]

    def complete_follow_up(self, follow_up_id: int) -> bool:
        self.db.execute(
            "UPDATE follow_ups SET status = 'done' WHERE id = ?", (follow_up_id,)
        )
        self.db.commit()

    # ── Saved Inbox Views ────────────────────────────────────────

    def get_saved_inbox_views(self) -> list[dict]:
        rows = self.db.execute(
            "SELECT id, slug, name, description, filters, is_default, is_shared, created_at, updated_at "
            "FROM saved_inbox_views ORDER BY is_default DESC, name ASC"
        ).fetchall()
        return [dict(r) for r in rows]

    def get_saved_inbox_view(self, slug: str) -> dict | None:
        row = self.db.execute(
            "SELECT id, slug, name, description, filters, is_default, is_shared, created_at, updated_at "
            "FROM saved_inbox_views WHERE slug = ?", (slug,)
        ).fetchone()
        return dict(row) if row else None

    def create_saved_inbox_view(self, slug: str, name: str, filters: dict,
                                 description: str = "", is_default: bool = False,
                                 is_shared: bool = False) -> int:
        import json
        cur = self.db.execute(
            """INSERT INTO saved_inbox_views
               (slug, name, description, filters, is_default, is_shared)
               VALUES (?,?,?,?,?,?)""",
            (slug, name, description, json.dumps(filters), int(is_default), int(is_shared))
        )
        self.db.commit()
        return cur.lastrowid

    def update_saved_inbox_view(self, slug: str, name: str = None, filters: dict = None,
                                 description: str = None, is_default: bool = None,
                                 is_shared: bool = None) -> bool:
        import json
        sets = []
        params = []
        if name is not None:
            sets.append("name = ?")
            params.append(name)
        if filters is not None:
            sets.append("filters = ?")
            params.append(json.dumps(filters))
        if description is not None:
            sets.append("description = ?")
            params.append(description)
        if is_default is not None:
            sets.append("is_default = ?")
            params.append(int(is_default))
        if is_shared is not None:
            sets.append("is_shared = ?")
            params.append(int(is_shared))
        if not sets:
            return False
        sets.append("updated_at = datetime('now')")
        params.append(slug)
        self.db.execute(
            f"UPDATE saved_inbox_views SET {', '.join(sets)} WHERE slug = ?", params
        )
        self.db.commit()
        return True

    def delete_saved_inbox_view(self, slug: str) -> bool:
        cur = self.db.execute(
            "DELETE FROM saved_inbox_views WHERE slug = ?", (slug,)
        )
        self.db.commit()
        return cur.rowcount > 0

    # ── Saved Inbox Views ────────────────────────────────────────

    def get_saved_inbox_views(self) -> list[dict]:
        rows = self.db.execute(
            "SELECT id, slug, name, description, filters, is_default, is_shared, created_at, updated_at "
            "FROM saved_inbox_views ORDER BY is_default DESC, name ASC"
        ).fetchall()
        return [dict(r) for r in rows]

    def get_saved_inbox_view(self, slug: str) -> dict | None:
        row = self.db.execute(
            "SELECT id, slug, name, description, filters, is_default, is_shared, created_at, updated_at "
            "FROM saved_inbox_views WHERE slug = ?", (slug,)
        ).fetchone()
        return dict(row) if row else None

    def create_saved_inbox_view(self, slug: str, name: str, filters: dict,
                                 description: str = "", is_default: bool = False,
                                 is_shared: bool = False) -> int:
        import json
        cur = self.db.execute(
            """INSERT INTO saved_inbox_views
               (slug, name, description, filters, is_default, is_shared)
               VALUES (?,?,?,?,?,?)""",
            (slug, name, description, json.dumps(filters), int(is_default), int(is_shared))
        )
        self.db.commit()
        return cur.lastrowid

    def update_saved_inbox_view(self, slug: str, name: str = None, filters: dict = None,
                                 description: str = None, is_default: bool = None,
                                 is_shared: bool = None) -> bool:
        import json
        sets = []
        params = []
        if name is not None:
            sets.append("name = ?")
            params.append(name)
        if filters is not None:
            sets.append("filters = ?")
            params.append(json.dumps(filters))
        if description is not None:
            sets.append("description = ?")
            params.append(description)
        if is_default is not None:
            sets.append("is_default = ?")
            params.append(int(is_default))
        if is_shared is not None:
            sets.append("is_shared = ?")
            params.append(int(is_shared))
        if not sets:
            return False
        sets.append("updated_at = datetime('now')")
        params.append(slug)
        self.db.execute(
            f"UPDATE saved_inbox_views SET {', '.join(sets)} WHERE slug = ?", params
        )
        self.db.commit()
        return True

    def delete_saved_inbox_view(self, slug: str) -> bool:
        cur = self.db.execute(
            "DELETE FROM saved_inbox_views WHERE slug = ?", (slug,)
        )
        self.db.commit()
        return cur.rowcount > 0
