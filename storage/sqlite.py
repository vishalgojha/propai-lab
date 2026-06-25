"""SQLite implementation of the Storage interface."""

import json
import sqlite3
from pathlib import Path
from typing import Optional

from storage.base import (
    Storage,
    RawMessage, ParsedObservation, ResolverDecision,
    Evaluation, SyncJob, SyncCheckpoint,
    dict_to_dataclass,
)


class SqliteStorage(Storage):
    """Single SQLite connection — not thread-safe, use one per process."""

    def __init__(self, db_path: Path):
        self.db_path = db_path
        self._db: sqlite3.Connection | None = None

    # ── Connection ─────────────────────────────────────────────

    @property
    def db(self) -> sqlite3.Connection:
        if self._db is None:
            self._db = sqlite3.connect(str(self.db_path))
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
        ]
        for sql in migs:
            try:
                self.db.execute(sql)
            except sqlite3.OperationalError:
                pass
        self._commit()

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
        cur = self.db.execute(
            """INSERT INTO raw_messages
               (group_name, sender, message, message_type, timestamp, source,
                raw_payload, message_uid, pipeline_version, synced_at)
               VALUES (?,?,?,?,?,?,?,?,?,?)""",
            (msg.group_name, msg.sender, msg.message, msg.message_type,
             msg.timestamp, msg.source, msg.raw_payload, msg.message_uid,
             msg.pipeline_version, msg.synced_at)
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
        cur = self.db.execute(
            """INSERT INTO parsed_output
               (raw_message_id, message_type, bhk, price, price_unit, area_sqft,
                furnishing, location_raw, building_name, landmark_name, street_name,
                area, micro_market, developer, broker_name, broker_phone,
                confidence, raw_payload)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (obs.raw_message_id, obs.message_type, obs.bhk, obs.price,
             obs.price_unit, obs.area_sqft, obs.furnishing, obs.location_raw,
             obs.building_name, obs.landmark_name, obs.street_name,
             obs.area, obs.micro_market, obs.developer,
             obs.broker_name, obs.broker_phone,
             obs.confidence, obs.raw_payload)
        )
        self._commit()
        return cur.lastrowid

    def get_parsed_by_raw(self, raw_id: int) -> ParsedObservation | None:
        row = self.db.execute(
            "SELECT * FROM parsed_output WHERE raw_message_id = ? ORDER BY id DESC LIMIT 1",
            (raw_id,)
        ).fetchone()
        return dict_to_dataclass(ParsedObservation, row) if row else None

    def get_parsed(self, limit: int = 50, offset: int = 0) -> list[dict]:
        rows = self.db.execute(
            """SELECT p.*, r.message as raw_message
               FROM parsed_output p
               JOIN raw_messages r ON r.id = p.raw_message_id
               ORDER BY p.id DESC LIMIT ? OFFSET ?""",
            (limit, offset)
        ).fetchall()
        return [dict(r) for r in rows]

    # ── Resolver decisions ─────────────────────────────────────

    def save_resolver_decision(self, dec: ResolverDecision) -> int:
        cur = self.db.execute(
            """INSERT INTO resolver_decisions
               (parsed_id, building_id, building_name,
                landmark_id, landmark_name, street_id, street_name,
                project_id, project_name, developer_name,
                parser_confidence, resolver_confidence, final_confidence,
                method, method_detail, candidates, failure_category, error)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (dec.parsed_id, dec.building_id, dec.building_name,
             dec.landmark_id, dec.landmark_name, dec.street_id, dec.street_name,
             dec.project_id, dec.project_name, dec.developer_name,
             dec.parser_confidence, dec.resolver_confidence, dec.final_confidence,
             dec.method, dec.method_detail, dec.candidates,
             dec.failure_category, dec.error)
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
            f"""SELECT rd.*, p.message_type, p.building_name as parsed_building,
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

    def get_failed(self, limit: int = 50) -> list[dict]:
        rows = self.db.execute(
            """SELECT rd.*, p.message_type, p.location_raw, p.landmark_name,
                      r.message as raw_message, r.sender, r.timestamp
               FROM resolver_decisions rd
               JOIN parsed_output p ON p.id = rd.parsed_id
               JOIN raw_messages r ON p.raw_message_id = r.id
               WHERE rd.method IN ('unresolved', 'error')
               ORDER BY rd.id DESC LIMIT ?""",
            (limit,)
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

    # ── Evaluations ────────────────────────────────────────────

    def save_evaluation(self, ev: Evaluation) -> int:
        existing = self.db.execute(
            "SELECT id FROM evaluations WHERE raw_message_id = ?",
            (ev.raw_message_id,)
        ).fetchone()
        if existing:
            cols = [
                "expected_message_type", "expected_bhk", "expected_price",
                "expected_price_unit", "expected_area_sqft", "expected_furnishing",
                "expected_building", "expected_landmark", "expected_street",
                "expected_area", "expected_micro_market", "expected_developer",
                "expected_broker",
                "extracted_message_type", "extracted_bhk", "extracted_price",
                "extracted_price_unit", "extracted_area_sqft", "extracted_furnishing",
                "extracted_building", "extracted_landmark", "extracted_street",
                "extracted_area", "extracted_micro_market", "extracted_developer",
                "extracted_broker",
                "accuracy_overall", "correction_notes", "evaluated_at",
            ]
            sets = ", ".join(f"{c} = ?" for c in cols)
            vals = [getattr(ev, c, None) for c in cols] + [ev.raw_message_id]
            self.db.execute(f"UPDATE evaluations SET {sets} WHERE raw_message_id = ?", vals)
            self._commit()
            return existing["id"]
        cur = self.db.execute(
            """INSERT INTO evaluations
               (raw_message_id,
                expected_message_type, expected_bhk, expected_price,
                expected_price_unit, expected_area_sqft, expected_furnishing,
                expected_building, expected_landmark, expected_street,
                expected_area, expected_micro_market, expected_developer,
                expected_broker,
                extracted_message_type, extracted_bhk, extracted_price,
                extracted_price_unit, extracted_area_sqft, extracted_furnishing,
                extracted_building, extracted_landmark, extracted_street,
                extracted_area, extracted_micro_market, extracted_developer,
                extracted_broker,
                accuracy_overall, correction_notes, evaluated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (ev.raw_message_id,
             ev.expected_message_type, ev.expected_bhk, ev.expected_price,
             ev.expected_price_unit, ev.expected_area_sqft, ev.expected_furnishing,
             ev.expected_building, ev.expected_landmark, ev.expected_street,
             ev.expected_area, ev.expected_micro_market, ev.expected_developer,
             ev.expected_broker,
             ev.extracted_message_type, ev.extracted_bhk, ev.extracted_price,
             ev.extracted_price_unit, ev.extracted_area_sqft, ev.extracted_furnishing,
             ev.extracted_building, ev.extracted_landmark, ev.extracted_street,
             ev.extracted_area, ev.extracted_micro_market, ev.extracted_developer,
             ev.extracted_broker,
             ev.accuracy_overall, ev.correction_notes, ev.evaluated_at)
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
        parsed_row = db.execute(
            "SELECT * FROM parsed_output WHERE raw_message_id = ? ORDER BY id DESC LIMIT 1",
            (obs_id,)
        ).fetchone()
        parsed_dict = dict(parsed_row) if parsed_row else {}
        resolver_dict = {}
        if parsed_dict:
            r_row = db.execute(
                "SELECT * FROM resolver_decisions WHERE parsed_id = ? ORDER BY id DESC LIMIT 1",
                (parsed_dict["id"],)
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
            "parsed": parsed_dict,
            "resolver": resolver_dict,
            "evaluation": eval_dict,
        }

    # ── Source summary ─────────────────────────────────────────

    def source_summary(self) -> dict:
        rows = self.db.execute(
            "SELECT source, COUNT(*) as cnt FROM raw_messages GROUP BY source"
        ).fetchall()
        return {r["source"]: r["cnt"] for r in rows}
