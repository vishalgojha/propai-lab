"""Supabase implementation of the Storage interface."""

import json
import os
import re
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Optional

import httpx

from lab.storage.base import (
    Storage, RawMessage, ParsedObservation, Listing,
    ResolverDecision, Evaluation, SyncJob, SyncCheckpoint,
    AISuggestion, LLMProvider,
    dict_to_dataclass,
)
from lab.inventory import listing_fingerprint, listing_label


_EMOJI_ICON_RE = re.compile(
    "["
    "\U0001F1E0-\U0001F1FF"
    "\U0001F300-\U0001F5FF"
    "\U0001F600-\U0001F64F"
    "\U0001F680-\U0001F6FF"
    "\U0001F900-\U0001F9FF"
    "\U0001FA00-\U0001FAFF"
    "\u200d"
    "\u20e3"
    "\u231a-\u23ff"
    "\u25a0-\u25ff"
    "\u2600-\u27bf"
    "\u2934-\u2935"
    "\u2b05-\u2b55"
    "\u3030"
    "\u303d"
    "\u3297"
    "\u3299"
    "\ufe00-\ufe0f"
    "]+",
    flags=re.UNICODE,
)


def _strip_icons(value: str = "") -> str:
    clean = _EMOJI_ICON_RE.sub("", value or "")
    clean = re.sub(r"[ \t]+", " ", clean)
    clean = re.sub(r" *\n *", "\n", clean)
    clean = re.sub(r"\n{3,}", "\n\n", clean)
    return clean.strip()


def _sanitize_parsed_payload(value: Any) -> Any:
    if isinstance(value, str):
        return _strip_icons(value)
    if isinstance(value, list):
        return [_sanitize_parsed_payload(item) for item in value]
    if isinstance(value, dict):
        return {key: _sanitize_parsed_payload(item) for key, item in value.items()}
    return value


def _clean_person_name(name: str = "") -> str:
    clean = (name or "").strip()
    clean = re.sub(r"\s*\([^)]*(?:\+?\d|X{2,})[^)]*\)\s*", " ", clean, flags=re.I)
    clean = re.sub(r"\s*\+?\d[\d\s().-]{7,}\s*", " ", clean)
    clean = re.sub(r"\s{2,}", " ", clean).strip(" -")
    return clean


def _normalize_india_phone(value: str = "") -> str:
    raw = (value or "").strip()
    if not raw or re.search(r"[xX*•]", raw):
        return ""
    digits = re.sub(r"\D", "", raw)
    if len(digits) == 12 and digits.startswith("91"):
        digits = digits[-10:]
    elif len(digits) == 11 and digits.startswith("0"):
        digits = digits[-10:]
    if len(digits) == 10 and re.match(r"^[6-9]\d{9}$", digits):
        return digits
    return ""


def _is_market_group_name(group_name: str = "") -> bool:
    gn = (group_name or "").strip()
    if not gn or gn in ("seed", "seed-bot", "status@broadcast", "broadcast"):
        return False
    return not (
        gn.endswith("@s.whatsapp.net")
        or gn.endswith("@lid")
        or gn.endswith("@newsletter")
        or gn.endswith("@broadcast")
    )


@dataclass
class _APIResponse:
    data: list[dict]
    count: Optional[int] = None
    status_code: int = 200
    error: Optional[str] = None


class _SupabaseRow(dict):
    """Row wrapper that behaves like both a dict and a tuple-like row."""

    def __init__(self, data: dict[str, Any]):
        super().__init__(data)
        self._keys = list(data.keys())

    def __getitem__(self, key):
        if isinstance(key, int):
            return super().__getitem__(self._keys[key])
        return super().__getitem__(key)


class _SupabaseResult:
    def __init__(self, rows: list[dict[str, Any]], rowcount: int = 0):
        self._rows = [_SupabaseRow(row) for row in rows]
        self.rowcount = rowcount

    def fetchone(self):
        return self._rows[0] if self._rows else None

    def fetchall(self):
        return self._rows

    def __iter__(self):
        return iter(self._rows)


class _SupabaseDatabaseAdapter:
    def __init__(self, client: "_RestClient"):
        self._client = client
        self.row_factory = None

    @staticmethod
    def _translate_sql(sql: str, params: tuple[Any, ...] | list[Any] | None) -> tuple[str, list[Any]]:
        text = (sql or "").strip().rstrip(";")
        if not params:
            return text, []

        translated: list[str] = []
        idx = 0
        for ch in text:
            if ch == "?":
                idx += 1
                translated.append(f"${idx}")
            else:
                translated.append(ch)

        # Apply SQLite-to-Postgres function translations
        translated_sql = "".join(translated)
        # INSTR(haystack, needle) -> POSITION(needle IN haystack) or split_part for common '@' case
        # Handle INSTR(sender_jid, '@') pattern
        translated_sql = re.sub(
            r'INSTR\s*\(\s*(\w+)\s*,\s*[\'"]([^\'"]+)[\'"]\s*\)',
            r'POSITION(\2 IN \1)',
            translated_sql,
            flags=re.IGNORECASE,
        )
        # General INSTR(haystack, needle) -> POSITION(needle IN haystack)
        translated_sql = re.sub(
            r'INSTR\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)',
            r'POSITION(\2 IN \1)',
            translated_sql,
            flags=re.IGNORECASE,
        )
        # SUBSTR(str, start, length) -> SUBSTRING(str FROM start FOR length)
        translated_sql = re.sub(
            r'SUBSTR\s*\(\s*([^,]+)\s*,\s*([^,]+)\s*,\s*([^)]+)\s*\)',
            r'SUBSTRING(\1 FROM \2 FOR \3)',
            translated_sql,
            flags=re.IGNORECASE,
        )
        # SUBSTR(str, start) -> SUBSTRING(str FROM start)
        translated_sql = re.sub(
            r'SUBSTR\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)',
            r'SUBSTRING(\1 FROM \2)',
            translated_sql,
            flags=re.IGNORECASE,
        )
        # IFNULL(a, b) -> COALESCE(a, b)
        translated_sql = re.sub(
            r'IFNULL\s*\(\s*([^,]+)\s*,\s*([^)]+)\s*\)',
            r'COALESCE(\1, \2)',
            translated_sql,
            flags=re.IGNORECASE,
        )
        # Boolean literals
        translated_sql = translated_sql.replace("TRUE", "true").replace("FALSE", "false")

        return translated_sql, list(params)

    @staticmethod
    def _is_query(sql: str) -> bool:
        head = re.sub(r"^\s*(?:--.*?\n|/\*.*?\*/\s*)*", "", sql, flags=re.S).lstrip().lower()
        return head.startswith(("select", "with", "show", "values", "explain")) or " returning " in f" {head} "

    def execute(self, sql: str, params: tuple[Any, ...] | list[Any] | None = None):
        rendered_sql, rendered_params = self._translate_sql(sql, params)
        import logging
        logging.info(f"propai_query_sql RPC - sql: {rendered_sql[:200]}... params: {rendered_params}")
        if self._is_query(rendered_sql):
            data = self._client.rpc(
                "propai_query_sql",
                {"sql": rendered_sql, "params": rendered_params},
            )
            rows = data if isinstance(data, list) else []
            return _SupabaseResult(rows, rowcount=len(rows))

        data = self._client.rpc(
            "propai_run_sql",
            {"sql": rendered_sql, "params": rendered_params},
        )
        rowcount = 0
        if isinstance(data, dict):
            try:
                rowcount = int(data.get("row_count", 0) or 0)
            except (TypeError, ValueError):
                rowcount = 0
        return _SupabaseResult([], rowcount=rowcount)

    def commit(self):
        return None

    def close(self):
        return None


class _NotFilterBuilder:
    def __init__(self, query: "_QueryBuilder"):
        self._query = query

    def is_(self, column: str, value: str):
        self._query._filters.append((column, "not.is", value))
        return self._query


class _QueryBuilder:
    def __init__(self, client: "_RestClient", table: str):
        self._client = client
        self._table = table
        self._op = "select"
        self._payload: Any = None
        self._select = "*"
        self._count = None
        self._order: list[tuple[str, bool]] = []
        self._limit: Optional[int] = None
        self._offset: Optional[int] = None
        self._filters: list[tuple[str, str, Any]] = []
        self._or: Optional[str] = None
        self._on_conflict: Optional[str] = None

    @property
    def not_(self):
        return _NotFilterBuilder(self)

    def select(self, columns: str = "*", count: str | None = None):
        self._op = "select"
        self._select = columns
        self._count = count
        return self

    def order(self, column: str, desc: bool = False):
        self._order.append((column, desc))
        return self

    def limit(self, value: int):
        self._limit = value
        return self

    def offset(self, value: int):
        self._offset = value
        return self

    def eq(self, column: str, value: Any):
        self._filters.append((column, "eq", value))
        return self

    def neq(self, column: str, value: Any):
        self._filters.append((column, "neq", value))
        return self

    def gte(self, column: str, value: Any):
        self._filters.append((column, "gte", value))
        return self

    def ilike(self, column: str, value: Any):
        self._filters.append((column, "ilike", value))
        return self

    def in_(self, column: str, values: list[Any]):
        self._filters.append((column, "in", values))
        return self

    def or_(self, expression: str):
        self._or = expression
        return self

    def insert(self, payload: Any):
        self._op = "insert"
        self._payload = payload
        return self

    def upsert(self, payload: Any, on_conflict: str | None = None):
        self._op = "upsert"
        self._payload = payload
        self._on_conflict = on_conflict
        return self

    def update(self, payload: dict[str, Any]):
        self._op = "update"
        self._payload = payload
        return self

    def delete(self):
        self._op = "delete"
        return self

    def execute(self):
        return self._client._execute(self)


class _RestClient:
    def __init__(self, url: str, key: str):
        self._base_url = url.rstrip("/")
        self._headers = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        self._http = httpx.Client(timeout=30.0, headers=self._headers)

    def table(self, name: str):
        return _QueryBuilder(self, name)

    def rpc(self, name: str, params: dict[str, Any] | None = None):
        url = f"{self._base_url}/rest/v1/rpc/{name}"
        res = self._http.post(url, content=json.dumps(params or {}))
        res.raise_for_status()
        if not res.text:
            return []
        return res.json()

    def close(self):
        self._http.close()

    def _execute(self, query: _QueryBuilder):
        url = f"{self._base_url}/rest/v1/{query._table}"
        params: list[tuple[str, Any]] = []

        if query._op == "select":
            params.append(("select", query._select))
        if query._or:
            params.append(("or", f"({query._or})"))
        for column, op, value in query._filters:
            if op == "in":
                rendered = ",".join(str(v) for v in value)
                params.append((column, f"in.({rendered})"))
            elif op == "not.is":
                params.append((column, f"not.is.{value}"))
            else:
                params.append((column, f"{op}.{value}"))
        for column, desc in query._order:
            params.append(("order", f"{column}.{ 'desc' if desc else 'asc' }"))
        if query._limit is not None:
            params.append(("limit", query._limit))
        if query._offset is not None:
            params.append(("offset", query._offset))
        if query._count == "exact":
            self._http.headers["Prefer"] = "count=exact"
        else:
            self._http.headers.pop("Prefer", None)

        if query._op == "select":
            res = self._http.get(url, params=params)
        elif query._op in {"insert", "upsert"}:
            headers = {"Prefer": "return=representation"}
            if query._op == "upsert":
                headers["Prefer"] = "resolution=merge-duplicates,return=representation"
                if query._on_conflict:
                    params.append(("on_conflict", query._on_conflict))
            res = self._http.post(url, params=params, content=json.dumps(query._payload), headers=headers)
        elif query._op == "update":
            res = self._http.patch(url, params=params, content=json.dumps(query._payload), headers={"Prefer": "return=representation"})
        elif query._op == "delete":
            res = self._http.delete(url, params=params, headers={"Prefer": "return=representation"})
        else:
            raise ValueError(f"Unsupported operation: {query._op}")

        res.raise_for_status()
        data = res.json() if res.text else []
        if isinstance(data, dict):
            data = [data]
        count = None
        if query._count == "exact":
            content_range = res.headers.get("content-range", "")
            if "/" in content_range:
                try:
                    count = int(content_range.rsplit("/", 1)[1])
                except ValueError:
                    count = None
        return _APIResponse(data=data, count=count, status_code=res.status_code)


Client = _RestClient


def create_client(url: str, key: str) -> Client:
    return _RestClient(url, key)


class SupabaseStorage(Storage):
    """Postgres/Supabase backend implementing the Storage interface."""

    def __init__(self, url: str = "", key: str = ""):
        url = url or os.getenv("SUPABASE_URL", "")
        key = key or os.getenv("SUPABASE_SERVICE_KEY", "")
        if not url or not key:
            raise ValueError("SUPABASE_URL and SUPABASE_SERVICE_KEY required")
        self._client: Client = create_client(url, key)
        self._db = _SupabaseDatabaseAdapter(self._client)
        self._tenant_id: str | None = None

    @property
    def client(self) -> Client:
        return self._client

    @property
    def db(self):
        return self._db

    @property
    def tenant_id(self) -> str | None:
        return self._tenant_id

    @tenant_id.setter
    def tenant_id(self, value: str | None):
        self._tenant_id = value

    def close(self):
        pass

    # ── User Profiles / Onboarding ─────────────────────────────────

    def _normalize_phone(self, phone: str) -> str:
        """Normalize phone to 10-digit format (last 10 digits)."""
        digits = "".join(ch for ch in phone if ch.isdigit())
        return digits[-10:] if len(digits) >= 10 else digits

    def get_user_profile(self, phone: str) -> dict | None:
        norm = self._normalize_phone(phone)
        try:
            res = self.client.table("user_profiles").select("*").eq("phone", norm).limit(1).execute()
            return res.data[0] if res.data else None
        except Exception:
            return None

    def save_user_profile(self, phone: str, data: dict) -> dict | None:
        norm = self._normalize_phone(phone)
        payload = {
            "phone": norm,
            "first_name": data.get("first_name", ""),
            "last_name": data.get("last_name", ""),
            "email": data.get("email", ""),
            "city": data.get("city", ""),
            "onboarding_complete": True,
            "updated_at": "now()",
        }
        existing = self.get_user_profile(norm)
        if existing:
            res = self.client.table("user_profiles").update(payload).eq("phone", norm).execute()
        else:
            res = self.client.table("user_profiles").insert(payload).execute()
        return res.data[0] if res and res.data else None

    # ── Permission helpers (shared with SqliteStorage) ─────────────

    PERMISSION_LABELS: list[tuple[str, str]] = [
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

    # ── Team Members ───────────────────────────────────────────────

    def list_team_members(self) -> list[dict]:
        try:
            res = self.client.table("team_members").select("*").order("role", desc=False).order("name", desc=False).execute()
            return res.data if res.data else []
        except Exception:
            return []

    def get_team_member(self, member_id: int) -> dict | None:
        try:
            res = self.client.table("team_members").select("*").eq("id", member_id).limit(1).execute()
            return res.data[0] if res.data else None
        except Exception:
            return None

    def create_team_member(self, name: str, email: str = "", phone: str = "",
                           role: str = "member", permission_keys: list[str] | None = None,
                           linked_broker_phone: str | None = None) -> dict:
        permissions = self._perm_bitfield(permission_keys or [])
        payload = {
            "name": name.strip(),
            "email": email.strip() or None,
            "phone": phone.strip() or None,
            "role": role,
            "permissions": permissions,
            "linked_broker_phone": linked_broker_phone,
        }
        res = self.client.table("team_members").insert(payload).execute()
        return res.data[0] if res and res.data else {}

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
        fields["updated_at"] = "now()"
        res = self.client.table("team_members").update(fields).eq("id", member_id).execute()
        return res.data[0] if res and res.data else None

    def deactivate_team_member(self, member_id: int) -> bool:
        try:
            self.client.table("team_members").update({
                "is_active": 0, "updated_at": "now()"
            }).eq("id", member_id).execute()
            return True
        except Exception:
            return False

    # ── Custom Roles ───────────────────────────────────────────────

    def list_team_roles(self) -> list[dict]:
        try:
            res = self.client.table("team_roles").select("*").order("is_system", desc=True).order("name", desc=False).execute()
            return res.data if res.data else []
        except Exception:
            return []

    def create_team_role(self, name: str, permission_keys: list[str]) -> dict | None:
        try:
            res = self.client.table("team_roles").insert({
                "name": name.strip(),
                "permission_keys": json.dumps(permission_keys),
                "is_system": False,
            }).execute()
            return res.data[0] if res and res.data else None
        except Exception:
            return None

    def update_team_role(self, role_id: int, name: str | None = None, permission_keys: list[str] | None = None) -> dict | None:
        fields = {}
        if name is not None:
            fields["name"] = name.strip()
        if permission_keys is not None:
            fields["permission_keys"] = json.dumps(permission_keys)
        if not fields:
            return self.get_team_role(role_id)
        try:
            res = self.client.table("team_roles").update(fields).eq("id", role_id).execute()
            return res.data[0] if res and res.data else None
        except Exception:
            return None

    def get_team_role(self, role_id: int) -> dict | None:
        try:
            res = self.client.table("team_roles").select("*").eq("id", role_id).limit(1).execute()
            return res.data[0] if res.data else None
        except Exception:
            return None

    def delete_team_role(self, role_id: int) -> bool:
        try:
            self.client.table("team_roles").delete().eq("id", role_id).execute()
            return True
        except Exception:
            return False

    def init_schema(self):
        pass

    # ── Multi-Tenant: Organizations ────────────────────────────────

    def create_organization(self, name: str, slug: str) -> dict | None:
        res = self.client.table("organizations").insert({
            "name": name, "slug": slug
        }).execute()
        return res.data[0] if res.data else None

    def get_organization(self, org_id: str) -> dict | None:
        res = self.client.table("organizations").select("*").eq("id", org_id).limit(1).execute()
        return res.data[0] if res.data else None

    def get_organization_by_slug(self, slug: str) -> dict | None:
        res = self.client.table("organizations").select("*").eq("slug", slug).limit(1).execute()
        return res.data[0] if res.data else None

    def list_organizations(self, limit: int = 100, offset: int = 0) -> list[dict]:
        res = self.client.table("organizations").select("*")\
            .order("created_at", desc=True).limit(limit).offset(offset).execute()
        return res.data or []

    def update_organization(self, org_id: str, **updates) -> bool:
        res = self.client.table("organizations").update(updates).eq("id", org_id).execute()
        return bool(res.data)

    def add_organization_member(self, org_id: str, user_id: str, role_id: int | None = None) -> dict | None:
        res = self.client.table("organization_members").insert({
            "organization_id": org_id, "user_id": user_id, "role_id": role_id
        }).execute()
        return res.data[0] if res.data else None

    def remove_organization_member(self, org_id: str, user_id: str) -> bool:
        res = self.client.table("organization_members").delete()\
            .eq("organization_id", org_id).eq("user_id", user_id).execute()
        return bool(res.data)

    def list_organization_members(self, org_id: str) -> list[dict]:
        res = self.client.table("organization_members").select("*, auth.users(email, phone)")\
            .eq("organization_id", org_id).execute()
        return res.data or []

    def get_user_organizations(self, user_id: str) -> list[dict]:
        res = self.client.table("organization_members").select("*, organizations(*)")\
            .eq("user_id", user_id).is_("is_active", True).execute()
        return [m["organizations"] for m in (res.data or []) if m.get("organizations")]

    # ── Multi-Tenant: Roles & Permissions ─────────────────────────

    def list_roles(self, org_id: str | None = None) -> list[dict]:
        q = self.client.table("roles").select("*")
        if org_id:
            q = q.eq("organization_id", org_id)
        else:
            q = q.is_("organization_id", None)
        return q.order("name", asc=True).execute().data or []

    def get_role(self, role_id: int) -> dict | None:
        res = self.client.table("roles").select("*").eq("id", role_id).limit(1).execute()
        return res.data[0] if res.data else None

    def create_role(self, org_id: str | None, name: str, slug: str, description: str = "") -> dict | None:
        res = self.client.table("roles").insert({
            "organization_id": org_id, "name": name, "slug": slug, "description": description
        }).execute()
        return res.data[0] if res.data else None

    def list_permissions(self) -> list[dict]:
        res = self.client.table("permissions").select("*").order("category", asc=True).order("label", asc=True).execute()
        return res.data or []

    def get_role_permissions(self, role_id: int) -> list[str]:
        res = self.client.table("role_permissions").select("permissions(key)")\
            .eq("role_id", role_id).execute()
        return [rp["permissions"]["key"] for rp in (res.data or []) if rp.get("permissions")]

    def set_role_permissions(self, role_id: int, permission_keys: list[str]):
        self.client.table("role_permissions").delete().eq("role_id", role_id).execute()
        perms = self.client.table("permissions").select("id").in_("key", permission_keys).execute()
        if perms.data:
            rows = [{"role_id": role_id, "permission_id": p["id"]} for p in perms.data]
            self.client.table("role_permissions").insert(rows).execute()

    def update_member_role(self, org_id: str, user_id: str, role_id: int) -> bool:
        res = self.client.table("organization_members").update({"role_id": role_id})\
            .eq("organization_id", org_id).eq("user_id", user_id).execute()
        return bool(res.data)

    # ── Multi-Tenant: Super Admin ─────────────────────────────────

    def is_super_admin(self, user_id: str) -> bool:
        res = self.client.table("super_admins").select("id").eq("user_id", user_id).limit(1).execute()
        return bool(res.data)

    def list_super_admins(self) -> list[dict]:
        res = self.client.table("super_admins").select("*, auth.users(email, phone)").execute()
        return res.data or []

    def add_super_admin(self, user_id: str, phone: str = "") -> dict | None:
        res = self.client.table("super_admins").insert({"user_id": user_id, "phone": phone}).execute()
        return res.data[0] if res.data else None

    def remove_super_admin(self, user_id: str) -> bool:
        res = self.client.table("super_admins").delete().eq("user_id", user_id).execute()
        return bool(res.data)

    # ── Multi-Tenant: WhatsApp Connections ────────────────────────

    def list_org_whatsapp_connections(self, org_id: str) -> list[dict]:
        res = self.client.table("org_whatsapp_connections").select("*")\
            .eq("organization_id", org_id).execute()
        return res.data or []

    def add_org_whatsapp_connection(self, org_id: str, phone_number: str, instance_name: str = "") -> dict | None:
        res = self.client.table("org_whatsapp_connections").insert({
            "organization_id": org_id, "phone_number": phone_number, "instance_name": instance_name
        }).execute()
        return res.data[0] if res.data else None

    def remove_org_whatsapp_connection(self, conn_id: int) -> bool:
        res = self.client.table("org_whatsapp_connections").delete().eq("id", conn_id).execute()
        return bool(res.data)

    # ── Raw Messages ─────────────────────────────────────────────

    RAW_MESSAGE_COLUMNS = {
        "group_name", "sender", "sender_jid", "sender_phone",
        "message", "message_type", "attachments", "reply_context",
        "timestamp", "source", "raw_payload", "message_uid",
        "processed", "processed_at", "tenant_id",
        "created_at",
    }

    def save_raw_message(self, msg: RawMessage) -> int:
        data = {k: v for k, v in msg.__dict__.items()
                if v is not None and k in self.RAW_MESSAGE_COLUMNS}
        data.pop("id", None)
        if not data.get("tenant_id") and self._tenant_id:
            data["tenant_id"] = self._tenant_id
        if isinstance(data.get("attachments"), str):
            try:
                data["attachments"] = json.loads(data["attachments"])
            except (json.JSONDecodeError, TypeError):
                data["attachments"] = []
        if isinstance(data.get("reply_context"), str):
            try:
                data["reply_context"] = json.loads(data["reply_context"])
            except (json.JSONDecodeError, TypeError):
                data["reply_context"] = {}
        if isinstance(data.get("raw_payload"), str):
            try:
                data["raw_payload"] = json.loads(data["raw_payload"])
            except (json.JSONDecodeError, TypeError):
                data["raw_payload"] = {}
        if "created_at" in data and not data["created_at"]:
            del data["created_at"]
        res = self.client.table("raw_messages").insert(data).execute()
        return res.data[0]["id"] if res.data else 0

    def get_raw_messages(self, limit: int = 50, offset: int = 0,
                          group_name: str = "", sender: str = "",
                          sender_phone: str = "", sender_jid: str = "",
                          source: str = "") -> list[RawMessage]:
        # Select only columns needed for RawMessage dataclass to avoid full row fetch
        cols = (
            "id, group_name, sender, sender_jid, sender_phone, message, message_type, "
            "attachments, reply_context, timestamp, source, raw_payload, message_uid, "
            "pipeline_version, synced_at, event_id, processed, processed_at, tenant_id, created_at"
        )
        query = self.client.table("raw_messages").select(cols).order("timestamp", desc=True).limit(limit).offset(offset)
        if group_name:
            query = query.eq("group_name", group_name)
        if sender:
            query = query.eq("sender", sender)
        if sender_phone:
            query = query.eq("sender_phone", sender_phone)
        if sender_jid:
            query = query.eq("sender_jid", sender_jid)
        if source:
            query = query.eq("source", source)
        res = query.execute()
        return [dict_to_dataclass(RawMessage, d) for d in res.data]

    def get_raw_message(self, msg_id: int) -> RawMessage | None:
        res = self.client.table("raw_messages").select("*").eq("id", msg_id).limit(1).execute()
        if res.data:
            return dict_to_dataclass(RawMessage, res.data[0])
        return None

    def get_raw_by_uid(self, message_uid: str) -> Optional[RawMessage]:
        res = self.client.table("raw_messages").select("*").eq("message_uid", message_uid).limit(1).execute()
        if res.data:
            return dict_to_dataclass(RawMessage, res.data[0])
        return None

    def get_all_raw_for_replay(self) -> list[RawMessage]:
        res = self.client.table("raw_messages").select("*").order("timestamp", desc=True).limit(1000).execute()
        return [dict_to_dataclass(RawMessage, d) for d in res.data]

    def get_unprocessed_raw_messages(self, limit: int = 100) -> list[RawMessage]:
        res = self.client.table("raw_messages").select("*")\
            .is_("processed", "false")\
            .order("id", desc=False).limit(limit).execute()
        return [dict_to_dataclass(RawMessage, d) for d in res.data]

    def mark_raw_processed(self, raw_id: int):
        now = datetime.now(timezone.utc).isoformat()
        self.client.table("raw_messages").update({
            "processed": True,
            "processed_at": now,
        }).eq("id", raw_id).execute()

    def count_unprocessed_raw(self) -> int:
        res = self.client.table("raw_messages").select("id", count="exact")\
            .is_("processed", "false").execute()
        return res.count if hasattr(res, "count") else 0

    @staticmethod
    def _payload_dict(value) -> dict:
        if isinstance(value, dict):
            return value
        if isinstance(value, str) and value:
            try:
                parsed = json.loads(value)
                return parsed if isinstance(parsed, dict) else {}
            except json.JSONDecodeError:
                return {}
        return {}

    @staticmethod
    def _jid_phone(jid: str = "") -> str:
        head = (jid or "").split("@", 1)[0]
        digits = re.sub(r"\D", "", head)
        return digits or head

    @staticmethod
    def _is_group_jid(value: str = "") -> bool:
        return (value or "").endswith("@g.us")

    @staticmethod
    def _is_direct_jid(value: str = "") -> bool:
        return (value or "").endswith("@s.whatsapp.net") or (value or "").endswith("@lid")

    def _source_group_maps(self) -> tuple[dict[str, str], dict[str, str]]:
        try:
            res = self.client.table("source_sync_jobs")\
                .select("group_id,group_name")\
                .neq("group_id", "")\
                .execute()
        except Exception:
            return {}, {}
        id_to_name: dict[str, str] = {}
        name_to_id: dict[str, str] = {}
        for row in (res.data or []):
            gid = (row.get("group_id") or "").strip()
            name = (row.get("group_name") or "").strip()
            if gid and name:
                id_to_name[gid] = name
                name_to_id.setdefault(name, gid)
        return id_to_name, name_to_id

    def _raw_chat_identity(
        self,
        row: dict,
        id_to_name: dict[str, str] | None = None,
        name_to_id: dict[str, str] | None = None,
    ) -> tuple[str, str, str]:
        id_to_name = id_to_name or {}
        name_to_id = name_to_id or {}
        payload = self._payload_dict(row.get("raw_payload"))
        key = payload.get("key") if isinstance(payload.get("key"), dict) else {}
        if not key and isinstance(payload.get("data"), dict):
            key = payload["data"].get("key") if isinstance(payload["data"].get("key"), dict) else {}
        chat_id = (
            key.get("remoteJid")
            or payload.get("remoteJid")
            or payload.get("from")
            or ""
        )
        message_uid = (row.get("message_uid") or "").strip()
        if not chat_id and ":" in message_uid:
            chat_id = message_uid.split(":", 1)[0]

        group_name = (row.get("group_name") or "").strip()
        sender_jid = (row.get("sender_jid") or "").strip()
        sender_phone = (row.get("sender_phone") or "").strip()
        sender = (row.get("sender") or "").strip()

        if not chat_id and group_name in name_to_id:
            chat_id = name_to_id[group_name]
        if not chat_id and self._is_group_jid(group_name):
            chat_id = group_name
        if not chat_id and self._is_direct_jid(group_name):
            chat_id = group_name
        if not chat_id:
            chat_id = sender_jid or sender_phone or group_name or sender or "unknown"

        chat_type = "group" if self._is_group_jid(chat_id) or (group_name and not self._is_direct_jid(group_name) and group_name not in ("seed", "seed-bot")) else "direct"
        if chat_type == "group":
            chat_name = id_to_name.get(chat_id) or (group_name if not self._is_group_jid(group_name) else "") or chat_id
        else:
            chat_name = _clean_person_name(sender) or sender_phone or self._jid_phone(chat_id) or "Direct Message"
        return chat_id, chat_type, chat_name

    @staticmethod
    def _decorate_chat_row(row: dict, chat_id: str, chat_type: str, chat_name: str, count: int | None = None) -> dict:
        decorated = dict(row)
        decorated["chat_id"] = chat_id
        decorated["chat_type"] = chat_type
        decorated["chat_name"] = chat_name
        decorated["conversation_key"] = chat_id
        decorated["conversation_type"] = "group" if chat_type == "group" else "direct"
        decorated["conversation_name"] = chat_name
        decorated["latest_message_at"] = decorated.get("timestamp") or decorated.get("created_at") or ""
        if count is not None:
            decorated["message_count"] = count
        return decorated

    def get_chats(self, limit: int = 500, offset: int = 0, tenant_id: str | None = None) -> list[dict]:
        query = self.client.table("raw_messages").select(
            "id,group_name,sender,sender_jid,sender_phone,message,message_type,"
            "timestamp,source,message_uid,created_at,tenant_id,attachments,reply_context"
        )\
            .order("timestamp", desc=True)\
            .limit(max(2000, limit + offset))
        tid = tenant_id or self._tenant_id
        if tid:
            query = query.eq("tenant_id", tid)
        res = query.execute()
        rows = res.data or []
        if not rows:
            return []

        id_to_name, name_to_id = self._source_group_maps()
        grouped: dict[str, dict] = {}
        counts: dict[str, int] = defaultdict(int)
        for row in rows:
            group_name = (row.get("group_name") or "").strip()
            sender_jid = (row.get("sender_jid") or "").strip()
            if group_name in ("status@broadcast", "broadcast") or group_name.endswith("@broadcast"):
                continue
            if group_name.endswith("@newsletter") or sender_jid.endswith("@newsletter"):
                continue
            chat_id, chat_type, chat_name = self._raw_chat_identity(row, id_to_name, name_to_id)
            if chat_id in ("seed", "seed-bot", "status@broadcast", "broadcast"):
                continue
            counts[chat_id] += 1
            if chat_id not in grouped:
                grouped[chat_id] = self._decorate_chat_row(row, chat_id, chat_type, chat_name)
        chats = []
        for chat_id, latest in grouped.items():
            latest["message_count"] = counts.get(chat_id, 0)
            chats.append(latest)
        chats.sort(key=lambda t: (t.get("timestamp") or t.get("created_at") or "", t.get("id") or 0), reverse=True)
        return chats[offset:offset + limit]

    def get_chat_messages(self, chat_id: str, limit: int = 200, offset: int = 0, tenant_id: str | None = None) -> list[RawMessage]:
        chat_id = (chat_id or "").strip()
        if not chat_id:
            return []
        id_to_name, _ = self._source_group_maps()
        names = [chat_id]
        if chat_id in id_to_name:
            names.append(id_to_name[chat_id])
        digits = self._jid_phone(chat_id)
        tid = tenant_id or self._tenant_id
        collected: dict[int, dict] = {}

        def add_query(field: str, value: str, op: str = "eq"):
            if not value:
                return
            try:
                q = self.client.table("raw_messages").select("*").order("timestamp", desc=True).limit(limit + offset)
                if tid:
                    q = q.eq("tenant_id", tid)
                if op == "like":
                    q = q.like(field, value)
                else:
                    q = q.eq(field, value)
                for row in (q.execute().data or []):
                    rid = row.get("id")
                    if rid is not None:
                        collected[int(rid)] = row
            except Exception:
                return

        add_query("message_uid", f"{chat_id}:%", "like")
        for name in names:
            add_query("group_name", name)
        add_query("sender_jid", chat_id)
        if digits:
            add_query("sender_phone", digits)

        rows = list(collected.values())
        rows.sort(key=lambda r: (r.get("timestamp") or r.get("created_at") or "", r.get("id") or 0), reverse=True)
        return [dict_to_dataclass(RawMessage, row) for row in rows[offset:offset + limit]]

    def get_inbox_threads(self, limit: int = 500, offset: int = 0, tenant_id: str | None = None) -> list[dict]:
        try:
            parsed_threads = self._get_parsed_market_threads(limit, offset, tenant_id=tenant_id)
            if parsed_threads:
                return parsed_threads
        except Exception:
            pass

        query = self.client.table("raw_messages").select("*")\
            .order("timestamp", desc=True)\
            .limit(max(5000, limit + offset))
        tid = tenant_id or self._tenant_id
        if tid:
            query = query.eq("tenant_id", tid)

        res = query.execute()
        rows = res.data if res.data else []
        if not rows:
            return []

        def broker_key(r: dict, parsed: dict | None = None) -> str:
            parsed = parsed or {}
            return (
                (r.get("sender_jid") or "").strip()
                or (r.get("sender_phone") or "").strip()
                or (parsed.get("broker_phone") or "").strip()
                or (parsed.get("broker_name") or "").strip()
                or (r.get("sender") or "").strip()
                or "unknown"
            )

        def broker_label(r: dict, parsed: dict | None = None) -> str:
            parsed = parsed or {}
            return (
                _clean_person_name(parsed.get("broker_name") or "")
                or _clean_person_name(r.get("sender") or "")
                or (parsed.get("broker_phone") or "").strip()
                or (r.get("sender_phone") or "").strip()
                or (r.get("sender_jid") or "").strip()
                or "Unknown broker"
            )

        groups: dict[str, list[dict]] = {}
        for row in rows:
            if not _is_market_group_name(row.get("group_name") or ""):
                continue
            key = broker_key(row)
            groups.setdefault(key, []).append(row)

        latest_ids = [msgs[0].get("id") for msgs in groups.values() if msgs and msgs[0].get("id")]
        parsed_map: dict[int, dict] = {}
        if latest_ids:
            parsed_res = self.client.table("parsed_output")\
                .select("raw_message_id,intent,building_name,micro_market,landmark_name,location_raw,broker_name,broker_phone,confidence")\
                .in_("raw_message_id", latest_ids[: max(1, limit + offset)])\
                .order("confidence", desc=True)\
                .order("id", desc=True)\
                .execute()
            for p in (parsed_res.data or []):
                rid = p.get("raw_message_id")
                if rid and rid not in parsed_map:
                    parsed_map[rid] = p

        threads = []
        for key, msgs in groups.items():
            latest = msgs[0]
            ts = latest.get("timestamp") or latest.get("created_at") or ""
            p = parsed_map.get(latest["id"])
            conv_name = broker_label(latest, p)
            chat_id = (
                latest.get("sender_jid")
                or latest.get("sender_phone")
                or (p or {}).get("broker_phone")
                or key
            )
            latest["chat_id"] = chat_id
            latest["chat_type"] = "direct"
            latest["chat_name"] = conv_name
            latest["conversation_key"] = key
            latest["conversation_type"] = "direct"
            latest["conversation_name"] = conv_name
            latest["message_count"] = len(msgs)
            latest["latest_message_at"] = ts
            if p:
                for field in ("intent", "building_name", "micro_market", "landmark_name", "location_raw", "broker_name", "broker_phone"):
                    if p.get(field):
                        latest[field] = p[field]
            threads.append(latest)

        threads.sort(key=lambda t: (t.get("timestamp") or t.get("created_at") or ""), reverse=True)
        return threads[offset:offset + limit]

    def _get_parsed_market_threads(self, limit: int, offset: int, tenant_id: str | None = None) -> list[dict]:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        tid = tenant_id or self._tenant_id

        query = self.client.table("parsed_output")\
            .select("id,raw_message_id,message_type,intent,bhk,price,price_unit,area_sqft,furnishing,location_raw,building_name,landmark_name,micro_market,broker_name,broker_phone,profile_name,listing_index,confidence,summary_title,normalized_message,created_at,raw_messages(*)")\
            .gte("created_at", cutoff)\
            .order("created_at", desc=True)\
            .limit(max(5000, limit + offset))
        if tid:
            query = query.eq("tenant_id", tid)
        parsed_rows = query.execute().data or []
        if not parsed_rows:
            return []

        grouped: dict[str, dict] = {}
        for parsed in parsed_rows:
            raw = parsed.get("raw_messages") or {}
            if not _is_market_group_name(raw.get("group_name") or ""):
                continue

            phone = (
                _normalize_india_phone(parsed.get("broker_phone") or "")
                or _normalize_india_phone(raw.get("sender_phone") or "")
                or _normalize_india_phone((raw.get("sender_jid") or "").split("@")[0])
            )
            name = (
                _clean_person_name(parsed.get("broker_name") or "")
                or _clean_person_name(parsed.get("profile_name") or "")
                or _clean_person_name(raw.get("sender") or "")
            )
            if not phone and not name:
                continue

            identity = phone or f"name:{name.lower()}"
            ts = raw.get("timestamp") or parsed.get("created_at") or raw.get("created_at") or ""
            bucket = grouped.setdefault(identity, {
                "latest": None,
                "message_count": 0,
                "listing_count": 0,
                "requirement_count": 0,
                "source_group_names": set(),
                "latest_ts": "",
            })

            bucket["message_count"] += 1
            intent = (parsed.get("intent") or "").upper()
            if intent in {"BUY", "BUYER", "REQUIREMENT", "RENTAL_SEEKER"}:
                bucket["requirement_count"] += 1
            else:
                bucket["listing_count"] += 1
            if raw.get("group_name"):
                bucket["source_group_names"].add(raw.get("group_name"))

            if not bucket["latest"] or str(ts) > str(bucket["latest_ts"]):
                bucket["latest"] = (parsed, raw, phone, name, identity)
                bucket["latest_ts"] = ts

        threads: list[dict] = []
        for bucket in grouped.values():
            latest = bucket.get("latest")
            if not latest:
                continue
            parsed, raw, phone, name, identity = latest
            conv_name = name or (phone and phone) or "Unknown broker"
            chat_id = phone or identity
            raw_row = dict(raw)
            raw_row.update({
                "chat_id": chat_id,
                "chat_type": "direct",
                "chat_name": conv_name,
                "conversation_key": identity,
                "conversation_type": "direct",
                "conversation_name": conv_name,
                "message_count": bucket["message_count"],
                "opportunity_count": bucket["message_count"],
                "listing_count": bucket["listing_count"],
                "requirement_count": bucket["requirement_count"],
                "latest_message_at": bucket["latest_ts"],
                "broker_name": name,
                "broker_phone": phone,
                "parsed_intent": parsed.get("intent"),
                "intent": parsed.get("intent"),
                "building_name": parsed.get("building_name"),
                "micro_market": parsed.get("micro_market"),
                "landmark_name": parsed.get("landmark_name"),
                "location_raw": parsed.get("location_raw"),
                "summary_title": parsed.get("summary_title"),
                "source_group_names": sorted(bucket["source_group_names"]),
            })
            threads.append(raw_row)

        threads.sort(key=lambda t: (t.get("latest_message_at") or t.get("timestamp") or t.get("created_at") or ""), reverse=True)
        return threads[offset:offset + limit]

    def count_raw_messages(self, group_name: str = "") -> int:
        query = self.client.table("raw_messages").select("id", count="exact")
        if group_name:
            query = query.eq("group_name", group_name)
        res = query.execute()
        return res.count or 0

    # ── Parsed Output ────────────────────────────────────────────

    PARSED_OUTPUT_COLUMNS = {
        "raw_message_id", "message_type", "intent", "principal",
        "bhk", "price", "price_unit", "area_sqft", "furnishing",
        "location_raw", "location", "building_name", "landmark_name",
        "street_name", "area", "micro_market", "developer",
        "broker_name", "broker_phone", "profile_name", "listing_index",
        "forwarded", "confidence", "raw_payload", "created_at",
        "summary_title", "normalized_message",
    }

    def save_parsed(self, parsed: ParsedObservation) -> int:
        data = {k: v for k, v in parsed.__dict__.items()
                if v is not None and k in self.PARSED_OUTPUT_COLUMNS}
        data.pop("id", None)
        data.pop("embedding", None)
        for field in ("raw_payload", "location"):
            if isinstance(data.get(field), str):
                try:
                    data[field] = json.loads(data[field])
                except (json.JSONDecodeError, TypeError):
                    data[field] = {} if field == "raw_payload" else None
        data = _sanitize_parsed_payload(data)
        res = self.client.table("parsed_output").insert(data).execute()
        return res.data[0]["id"] if res.data else 0

    def get_parsed_by_raw(self, raw_id: int) -> Optional[ParsedObservation]:
        res = self.client.table("parsed_output").select("*").eq("raw_message_id", raw_id).limit(1).execute()
        if res.data:
            return dict_to_dataclass(ParsedObservation, res.data[0])
        return None

    def get_parsed(self, limit: int = 50, offset: int = 0, intent: str = "") -> list[dict]:
        query = self.client.table("parsed_output").select("*").order("created_at", desc=True).limit(limit).offset(offset)
        if intent:
            query = query.eq("intent", intent)
        res = query.execute()
        return [dict_to_dataclass(ParsedObservation, d) for d in res.data]

    def get_parsed_by_message(self, raw_message_id: int) -> list[ParsedObservation]:
        res = self.client.table("parsed_output").select("*").eq("raw_message_id", raw_message_id).execute()
        return [dict_to_dataclass(ParsedObservation, d) for d in res.data]

    # ── Listings ─────────────────────────────────────────────────

    def save_listing(self, listing: Listing) -> int:
        data = {k: v for k, v in listing.__dict__.items() if v is not None}
        data.pop("id", None)
        if not data.get("fingerprint"):
            data["fingerprint"] = listing_fingerprint(data)
        if not data.get("location_label"):
            data["location_label"] = listing_label(data)
        res = self.client.table("listings").upsert(data, on_conflict="fingerprint").execute()
        return res.data[0]["id"] if res.data else 0

    def get_listings(self, limit: int = 50, offset: int = 0,
                      intent: str = "", bhk: str = "",
                      building: str = "", micro_market: str = "",
                      broker: str = "", sort_by: str = "last_seen") -> list[Listing]:
        query = self.client.table("listings").select("*").order(sort_by, desc=True).limit(limit).offset(offset)
        if intent:
            query = query.eq("intent", intent)
        if bhk:
            query = query.eq("bhk", bhk)
        if building:
            query = query.ilike("building_name", f"%{building}%")
        if micro_market:
            query = query.ilike("micro_market", f"%{micro_market}%")
        if broker:
            query = query.or_(f"broker_name.ilike.%{broker}%,broker_phone.ilike.%{broker}%")
        res = query.execute()
        return [dict_to_dataclass(Listing, d) for d in res.data]

    def get_listing_by_fingerprint(self, fingerprint: str) -> Listing | None:
        res = self.client.table("listings").select("*").eq("fingerprint", fingerprint).limit(1).execute()
        if res.data:
            return dict_to_dataclass(Listing, res.data[0])
        return None

    def rebuild_listings(self):
        pass

    # ── Clients ──────────────────────────────────────────────────

    def save_client(self, data: dict) -> dict:
        res = self.client.table("clients").insert(data).execute()
        return res.data[0] if res.data else {}

    def get_clients(self, search: str = "") -> list[dict]:
        query = self.client.table("clients").select("*").order("created_at", desc=True)
        if search:
            query = query.or_(f"name.ilike.%{search}%,phone.ilike.%{search}%")
        res = query.execute()
        return res.data

    def get_client(self, client_id: int) -> dict | None:
        res = self.client.table("clients").select("*").eq("id", client_id).limit(1).execute()
        return res.data[0] if res.data else None

    def create_client(self, name: str, phone: str = None, email: str = None, notes: str = "") -> int:
        data = {"name": name}
        if phone:
            data["phone"] = phone
        if email:
            data["email"] = email
        if notes:
            data["notes"] = notes
        res = self.client.table("clients").insert(data).execute()
        return res.data[0]["id"] if res.data else 0

    # ── Brokers ──────────────────────────────────────────────────

    def save_broker(self, data: dict) -> dict:
        if data.get("identity_key"):
            existing = self.client.table("brokers").select("id").eq("identity_key", data["identity_key"]).limit(1).execute()
            if existing.data:
                self.client.table("brokers").update(data).eq("id", existing.data[0]["id"]).execute()
                return existing.data[0]
        res = self.client.table("brokers").insert(data).execute()
        return res.data[0] if res.data else {}

    def get_brokers(self, search: str = "", limit: int = 100, offset: int = 0) -> list[dict]:
        query = self.client.table("brokers").select("*").order("observation_count", desc=True).limit(limit).offset(offset)
        if search:
            query = query.or_(f"canonical_name.ilike.%{search}%,primary_phone.ilike.%{search}%")
        res = query.execute()
        return res.data

    def get_broker(self, broker_id: int) -> dict | None:
        res = self.client.table("brokers").select("*").eq("id", broker_id).limit(1).execute()
        if not res.data:
            return None
        broker = res.data[0]
        
        # Get aliases
        aliases_res = self.client.table("broker_aliases").select("*").eq("broker_id", broker_id).order("observation_count", desc=True).limit(20).execute()
        broker["aliases"] = aliases_res.data if aliases_res.data else []
        
        # Get phones
        phones_res = self.client.table("broker_phones").select("*").eq("broker_id", broker_id).order("observation_count", desc=True).limit(10).execute()
        broker["phones"] = phones_res.data if phones_res.data else []
        
        # Get market stats
        markets_res = self.client.table("broker_market_stats").select("*").eq("broker_id", broker_id).order("observation_count", desc=True).limit(20).execute()
        broker["markets"] = markets_res.data if markets_res.data else []
        
        # Get building stats
        buildings_res = self.client.table("broker_building_stats").select("*").eq("broker_id", broker_id).order("observation_count", desc=True).limit(20).execute()
        broker["buildings"] = buildings_res.data if buildings_res.data else []
        
        return broker

    def find_broker(self, name: str = "", phone: str = "") -> dict | None:
        q = self.client.table("brokers").select("*")
        if phone:
            q = q.eq("primary_phone", phone)
        if name:
            q = q.ilike("canonical_name", name)
        res = q.limit(1).execute()
        return res.data[0] if res.data else None

    # ── Buildings ────────────────────────────────────────────────

    def save_building(self, data: dict) -> dict:
        if data.get("building_id"):
            existing = self.client.table("buildings").select("id").eq("building_id", data["building_id"]).limit(1).execute()
            if existing.data:
                self.client.table("buildings").update(data).eq("id", existing.data[0]["id"]).execute()
                return existing.data[0]
        res = self.client.table("buildings").insert(data).execute()
        return res.data[0] if res.data else {}

    def get_buildings(self, search: str = "", limit: int = 100, offset: int = 0) -> list[dict]:
        query = self.client.table("buildings").select("*").order("observed_listings", desc=True).limit(limit).offset(offset)
        if search:
            query = query.or_(f"canonical_name.ilike.%{search}%,micro_market.ilike.%{search}%")
        res = query.execute()
        return res.data

    def get_building(self, building_id: str) -> dict | None:
        res = self.client.table("buildings").select("*").eq("building_id", building_id).limit(1).execute()
        return res.data[0] if res.data else None

    # ── Resolver Decisions ───────────────────────────────────────

    def save_resolver_decision(self, dec: ResolverDecision) -> int:
        data = {k: v for k, v in dec.__dict__.items() if v is not None}
        data.pop("id", None)
        res = self.client.table("resolver_decisions").insert(data).execute()
        return res.data[0]["id"] if res.data else 0

    def get_resolver_by_parsed(self, parsed_id: int) -> Optional[ResolverDecision]:
        res = self.client.table("resolver_decisions").select("*").eq("parsed_id", parsed_id).limit(1).execute()
        if res.data:
            return dict_to_dataclass(ResolverDecision, res.data[0])
        return None

    def get_resolver_decisions(self, limit: int = 50, offset: int = 0,
                                method: str = "") -> list[dict]:
        query = self.client.table("resolver_decisions").select("*").order("id", desc=True).limit(limit).offset(offset)
        if method:
            query = query.eq("method", method)
        res = query.execute()
        return res.data

    def get_failed(self, limit: int = 50, offset: int = 0) -> list[dict]:
        res = self.client.table("resolver_decisions").select("*").eq("success", False).order("id", desc=True).limit(limit).offset(offset).execute()
        return res.data

    # ── Evaluations ──────────────────────────────────────────────

    def save_evaluation(self, ev: Evaluation) -> int:
        data = {k: v for k, v in ev.__dict__.items() if v is not None}
        data.pop("id", None)
        res = self.client.table("evaluations").insert(data).execute()
        return res.data[0]["id"] if res.data else 0

    def get_evaluation_by_raw(self, raw_id: int) -> Optional[Evaluation]:
        res = self.client.table("evaluations").select("*").eq("raw_message_id", raw_id).limit(1).execute()
        if res.data:
            return dict_to_dataclass(Evaluation, res.data[0])
        return None

    def get_evaluations(self, limit: int = 50, offset: int = 0) -> list[dict]:
        res = self.client.table("evaluations").select("*").order("id", desc=True).limit(limit).offset(offset).execute()
        return res.data

    # ── Sync Jobs ────────────────────────────────────────────────

    def create_sync_job(self, job: SyncJob) -> int:
        data = {k: v for k, v in job.__dict__.items() if v is not None}
        data.pop("id", None)
        res = self.client.table("sync_jobs").insert(data).execute()
        return res.data[0]["id"] if res.data else 0

    def update_sync_job(self, job_id: int, **updates):
        self.client.table("sync_jobs").update(updates).eq("id", job_id).execute()

    def get_sync_job(self, job_id: int) -> Optional[SyncJob]:
        res = self.client.table("sync_jobs").select("*").eq("id", job_id).limit(1).execute()
        if res.data:
            return dict_to_dataclass(SyncJob, res.data[0])
        return None

    def upsert_sync_job(self, source: str, instance: str = "",
                         group_id: str = "", group_name: str = "",
                         participants: int = 0,
                         status: str = "pending") -> int:
        existing = self.client.table("sync_jobs").select("id").eq("source", source).eq("group_id", group_id).limit(1).execute()
        if existing.data:
            self.client.table("sync_jobs").update({
                "status": status, "instance": instance,
                "group_name": group_name, "participants": participants,
            }).eq("id", existing.data[0]["id"]).execute()
            return existing.data[0]["id"]
        data = {"source": source, "instance": instance, "group_id": group_id,
                "group_name": group_name, "participants": participants, "status": status}
        res = self.client.table("sync_jobs").insert(data).execute()
        return res.data[0]["id"] if res.data else 0

    def prune_sync_jobs(self, source: str, instance: str,
                         keep_jids: set) -> int:
        all_jobs = self.client.table("sync_jobs").select("id,group_id").eq("source", source).eq("instance", instance).execute()
        removed = 0
        for job in all_jobs.data:
            if job["group_id"] not in keep_jids:
                self.client.table("sync_jobs").delete().eq("id", job["id"]).execute()
                removed += 1
        return removed

    def get_sync_jobs(self, limit: int = 200, offset: int = 0,
                       source: str = "", status: str = "") -> list[SyncJob]:
        query = self.client.table("sync_jobs").select("*").order("id", desc=True).limit(limit).offset(offset)
        if source:
            query = query.eq("source", source)
        if status:
            query = query.eq("status", status)
        res = query.execute()
        return [dict_to_dataclass(SyncJob, d) for d in res.data]

    def get_group_markets(self) -> dict[str, list[str]]:
        """Derived tags: aggregate distinct micro_markets per WhatsApp group
        from parsed_output joined to raw_messages by group_name.
        Returns {group_name: [market, ...]}."""
        try:
            res = self.client.table("parsed_output").select(
                "micro_market, raw_messages!inner(group_name)"
            ).not_.is_("micro_market", "null").neq("micro_market", "").limit(5000).execute()
            out: dict[str, set[str]] = {}
            for row in (res.data or []):
                rm = row.get("raw_messages") or {}
                gn = rm.get("group_name") if isinstance(rm, dict) else None
                mk = row.get("micro_market")
                if gn and mk:
                    out.setdefault(gn, set()).add(mk)
            return {k: sorted(v) for k, v in out.items()}
        except Exception:
            return {}

    # ── Sync Checkpoints ─────────────────────────────────────────

    def get_checkpoints(self, instance_name: str) -> list[SyncCheckpoint]:
        res = self.client.table("sync_checkpoints").select("*").eq("instance_name", instance_name).execute()
        return [dict_to_dataclass(SyncCheckpoint, d) for d in res.data]

    def save_checkpoint(self, cp: SyncCheckpoint):
        data = {k: v for k, v in cp.__dict__.items() if v is not None}
        data.pop("id", None)
        existing = self.client.table("sync_checkpoints").select("id").eq("instance_name", cp.instance_name).eq("group_jid", cp.group_jid).limit(1).execute()
        if existing.data:
            self.client.table("sync_checkpoints").update(data).eq("id", existing.data[0]["id"]).execute()
        else:
            self.client.table("sync_checkpoints").insert(data).execute()

    def get_checkpoint(self, instance_name: str,
                        group_jid: str) -> Optional[SyncCheckpoint]:
        res = self.client.table("sync_checkpoints").select("*").eq("instance_name", instance_name).eq("group_jid", group_jid).limit(1).execute()
        if res.data:
            return dict_to_dataclass(SyncCheckpoint, res.data[0])
        return None

    # ── Stats ────────────────────────────────────────────────────

    def get_stats(self) -> dict:
        msgs = self.client.table("raw_messages").select("id", count="exact").execute()
        parsed = self.client.table("parsed_output").select("id", count="exact").execute()
        listings = self.client.table("listings").select("id", count="exact").execute()
        brokers = self.client.table("brokers").select("id", count="exact").execute()
        buildings = self.client.table("buildings").select("id", count="exact").execute()
        requirements = self.client.table("parsed_output").select("id", count="exact")\
            .in_("intent", ["BUY", "BUYER", "REQUIREMENT", "RENTAL_SEEKER"]).execute()
        return {
            "total_messages": msgs.count or 0,
            "total_parsed": parsed.count or 0,
            "total_listings": listings.count or 0,
            "total_requirements": requirements.count or 0,
            "total_brokers": brokers.count or 0,
            "total_buildings": buildings.count or 0,
        }

    # ── Observation Detail ───────────────────────────────────────

    def get_observation_detail(self, obs_id: int) -> dict:
        # Get all parsed outputs for this raw message (handles multi-listing messages)
        parsed_res = self.client.table("parsed_output").select("*").eq("raw_message_id", obs_id).order("listing_index").execute()
        if not parsed_res.data:
            return {}
        
        parsed_rows = parsed_res.data
        first_parsed = parsed_rows[0] if parsed_rows else None
        
        # Get raw message
        raw_res = self.client.table("raw_messages").select("*").eq("id", obs_id).limit(1).execute()
        raw_dict = raw_res.data[0] if raw_res.data else {}
        
        # Get resolver decision for first parsed
        resolver_dict = {}
        if first_parsed:
            r_res = self.client.table("resolver_decisions").select("*").eq("parsed_id", first_parsed["id"]).order("id", desc=True).limit(1).execute()
            if r_res.data:
                resolver_dict = r_res.data[0]
                if isinstance(resolver_dict.get("candidates"), str):
                    try:
                        resolver_dict["candidates"] = json.loads(resolver_dict["candidates"])
                    except (json.JSONDecodeError, TypeError):
                        resolver_dict["candidates"] = []
        
        # Get evaluation
        eval_dict = {}
        eval_res = self.client.table("evaluations").select("*").eq("raw_message_id", obs_id).order("id", desc=True).limit(1).execute()
        if eval_res.data:
            eval_dict = eval_res.data[0]
        
        return {
            "raw": raw_dict,
            "parsed": first_parsed or {},
            "listings": parsed_rows,
            "resolver": resolver_dict,
            "evaluation": eval_dict,
        }

    def source_summary(self) -> dict:
        groups = self.client.table("raw_messages").select("group_name", count="exact").execute()
        return {
            "total_groups": len(set(d.get("group_name") for d in groups.data)) if groups.data else 0,
            "total_messages": groups.count or 0,
        }

    # ── AI Layer ─────────────────────────────────────────────────

    def get_all_parsed_with_embeddings(self) -> list[dict]:
        res = self.client.table("parsed_output").select("*").not_.is_("embedding", "null").limit(1000).execute()
        return res.data

    def knn_search(self, query_embedding: bytes, k: int = 10) -> list[dict]:
        return []

    def get_observations_by_broker(self, broker_name: str) -> list[dict]:
        res = self.client.table("parsed_output").select("*").eq("broker_name", broker_name).limit(100).execute()
        return res.data

    def get_observations_by_building(self, building_name: str) -> list[dict]:
        res = self.client.table("parsed_output").select("*").eq("building_name", building_name).limit(100).execute()
        return res.data

    def get_top_brokers_today(self, today_prefix: str, limit: int = 10) -> list[dict]:
        res = self.client.table("brokers").select("*").order("observation_count", desc=True).limit(limit).execute()
        return res.data

    # ── Dashboard ────────────────────────────────────────────────

    def dashboard_activity(self, today_prefix: str) -> dict:
        today = self.client.table("raw_messages").select("id", count="exact").gte("created_at", today_prefix).execute()
        return {
            "messages_today": today.count or 0,
            "message_types": {},
        }

    def dashboard_feed(self, limit: int = 20) -> list[dict]:
        res = self.client.table("parsed_output").select("*").order("created_at", desc=True).limit(limit).execute()
        return res.data

    def dashboard_heatmap(self) -> list[dict]:
        return []

    def dashboard_listings(self, limit: int = 20) -> list[dict]:
        res = self.client.table("listings").select("*").order("last_seen", desc=True).limit(limit).execute()
        return res.data

    def dashboard_requirements(self, limit: int = 20) -> list[dict]:
        res = self.client.table("parsed_output").select("*").eq("intent", "REQUIREMENT").order("created_at", desc=True).limit(limit).execute()
        return res.data

    def dashboard_signals(self) -> list[dict]:
        return []

    def dashboard_message_types_today(self, today_prefix: str) -> list[dict]:
        return []

    def dashboard_obs_types_today(self, today_prefix: str) -> list[dict]:
        return []

    def dashboard_growth(self, today_prefix: str) -> dict:
        return {"messages_growth": 0, "brokers_growth": 0, "listings_growth": 0}

    # ── Enrichment Jobs ──────────────────────────────────────────

    def create_enrichment_job(self, parsed_id: int, raw_message_id: int,
                               scheduled_after: str) -> int:
        data = {"parsed_id": parsed_id, "raw_message_id": raw_message_id,
                "scheduled_after": scheduled_after, "status": "pending"}
        res = self.client.table("enrichment_jobs").insert(data).execute()
        return res.data[0]["id"] if res.data else 0

    def get_pending_enrichment_jobs(self, limit: int = 50) -> list[dict]:
        res = self.client.table("enrichment_jobs").select("*").eq("status", "pending").limit(limit).execute()
        return res.data

    def claim_enrichment_job(self, job_id: int) -> bool:
        res = self.client.table("enrichment_jobs").update({"status": "in_progress"}).eq("id", job_id).eq("status", "pending").execute()
        return len(res.data) > 0

    def complete_enrichment_job(self, job_id: int, error: str = ""):
        updates = {"status": "done" if not error else "failed"}
        if error:
            updates["error"] = error
        self.client.table("enrichment_jobs").update(updates).eq("id", job_id).execute()

    def get_enrichment_job_by_parsed(self, parsed_id: int) -> Optional[dict]:
        res = self.client.table("enrichment_jobs").select("*").eq("parsed_id", parsed_id).limit(1).execute()
        return res.data[0] if res.data else None

    # ── Knowledge Graph Aliases ──────────────────────────────────

    def create_location_alias(self, alias: str, canonical: str,
                               confidence: float = 0.0, source: str = "ai") -> bool:
        data = {"alias": alias, "canonical": canonical, "confidence": confidence, "source": source}
        res = self.client.table("location_aliases").upsert(data, on_conflict="alias").execute()
        return len(res.data) > 0

    def create_building_alias(self, alias: str, canonical: str,
                               confidence: float = 0.0, source: str = "ai") -> bool:
        data = {"alias": alias, "canonical": canonical, "confidence": confidence, "source": source}
        res = self.client.table("building_aliases").upsert(data, on_conflict="alias").execute()
        return len(res.data) > 0

    def resolve_location(self, text: str) -> Optional[str]:
        res = self.client.table("location_aliases").select("canonical").eq("alias", text).limit(1).execute()
        if res.data:
            return res.data[0]["canonical"]
        return None

    def resolve_building(self, text: str) -> Optional[str]:
        res = self.client.table("building_aliases").select("canonical").eq("alias", text).limit(1).execute()
        if res.data:
            return res.data[0]["canonical"]
        return None

    # ── Price Stats ──────────────────────────────────────────────

    def recompute_price_stats(self):
        pass

    def get_price_stats(self, micro_market: str, bhk: str,
                         intent: str = "listing") -> Optional[dict]:
        res = self.client.table("listings").select("*").eq("micro_market", micro_market).eq("bhk", bhk).eq("intent", intent).execute()
        if not res.data:
            return None
        prices = [l.get("price", 0) for l in res.data if l.get("price")]
        if not prices:
            return None
        return {
            "micro_market": micro_market,
            "bhk": bhk,
            "intent": intent,
            "count": len(prices),
            "min": min(prices),
            "max": max(prices),
            "avg": sum(prices) / len(prices),
            "median": sorted(prices)[len(prices) // 2],
        }

    # ── Counts ───────────────────────────────────────────────────

    def message_count_today(self) -> int:
        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        res = self.client.table("raw_messages").select("id", count="exact").gte("created_at", today).execute()
        return res.count or 0

    def broker_count(self) -> int:
        res = self.client.table("brokers").select("id", count="exact").execute()
        return res.count or 0

    def listing_count(self) -> int:
        res = self.client.table("listings").select("id", count="exact").execute()
        return res.count or 0

    def building_count(self) -> int:
        res = self.client.table("buildings").select("id", count="exact").execute()
        return res.count or 0

    # ── Suggestions (AI) ─────────────────────────────────────────

    def get_suggestions(self, status: str = "pending", limit: int = 50, offset: int = 0) -> list[dict]:
        query = self.client.table("ai_suggestions").select("*").order("created_at", desc=True).limit(limit).offset(offset)
        if status != "all":
            query = query.eq("status", status)
        if self._tenant_id:
            query = query.eq("tenant_id", self._tenant_id)
        res = query.execute()
        return res.data or []

    def get_suggestion_counts(self) -> dict:
        counts = {"pending": 0, "approved": 0, "rejected": 0, "ignored": 0}
        query = self.client.table("ai_suggestions").select("status")
        if self._tenant_id:
            query = query.eq("tenant_id", self._tenant_id)
        res = query.execute()
        for row in res.data or []:
            status = row.get("status") or "pending"
            counts[status] = counts.get(status, 0) + 1
        return counts

    def create_suggestion(self, sug: AISuggestion) -> int:
        data = {k: v for k, v in sug.__dict__.items() if v is not None}
        data.pop("id", None)
        if not data.get("tenant_id") and self._tenant_id:
            data["tenant_id"] = self._tenant_id
        res = self.client.table("ai_suggestions").insert(data).execute()
        return res.data[0]["id"] if res.data else 0

    def apply_suggestion(self, sug_id: int) -> bool:
        res = self.client.table("ai_suggestions").update({"status": "applied"}).eq("id", sug_id).execute()
        return len(res.data) > 0

    def update_suggestion_status(self, sug_id: int, status: str, rejection_reason: str = ""):
        data = {"status": status}
        if rejection_reason:
            data["rejection_reason"] = rejection_reason
        self.client.table("ai_suggestions").update(data).eq("id", sug_id).execute()

    def batch_update_suggestions(self, ids: list[int], status: str, rejection_reason: str = ""):
        data = {"status": status}
        if rejection_reason:
            data["rejection_reason"] = rejection_reason
        self.client.table("ai_suggestions").update(data).in_("id", ids).execute()

    def get_ai_memory_stats(self) -> dict:
        return {"suggestions": 0, "memory_entries": 0}

    def get_ai_usage_stats(self, days: int = 1) -> dict:
        return {"requests": 0, "tokens": 0}

    # ── LLM Providers ──────────────────────────────────────────

    def get_llm_providers(self) -> list[LLMProvider]:
        res = self.client.table("llm_providers").select("*").order("is_active", desc=True).order("provider_name").execute()
        return [dict_to_dataclass(LLMProvider, r) for r in res.data]

    def get_active_llm_provider(self) -> Optional[LLMProvider]:
        res = self.client.table("llm_providers").select("*").eq("is_active", 1).limit(1).execute()
        return dict_to_dataclass(LLMProvider, res.data[0]) if res.data else None

    def save_llm_provider(self, provider: LLMProvider) -> int:
        data = {k: v for k, v in provider.__dict__.items() if v is not None}
        data.pop("created_at", None)
        data.pop("updated_at", None)
        if provider.id:
            data.pop("id", None)
            if not provider.api_key or "****" in provider.api_key:
                existing = self.client.table("llm_providers").select("api_key").eq("id", provider.id).execute()
                if existing.data and existing.data[0].get("api_key"):
                    data["api_key"] = existing.data[0]["api_key"]
            if provider.is_active:
                self.client.table("llm_providers").update({"is_active": 0}).neq("id", provider.id).execute()
            self.client.table("llm_providers").update(data).eq("id", provider.id).execute()
            return provider.id
        else:
            data.pop("id", None)
            if provider.is_active:
                self.client.table("llm_providers").update({"is_active": 0}).neq("id", 0).execute()
            res = self.client.table("llm_providers").insert(data).execute()
            return res.data[0]["id"] if res.data else 0

    def delete_llm_provider(self, provider_id: int) -> bool:
        res = self.client.table("llm_providers").delete().eq("id", provider_id).execute()
        return len(res.data) > 0

    # ── Observation Graph ────────────────────────────────────────────────

    def rebuild_observation_graph(self) -> dict:
        try:
            data = self.db.execute(
                "SELECT rebuild_observation_graph()"
            ).fetchone()
            if data:
                val = data[0]
                if isinstance(val, str):
                    import json
                    return json.loads(val)
                return dict(val)
            return {"observations": 0, "evidence": 0}
        except Exception:
            return {"observations": 0, "evidence": 0}

    def rebuild_broker_graph(self) -> dict:
        try:
            data = self.db.execute(
                "SELECT rebuild_broker_graph()"
            ).fetchone()
            if data:
                val = data[0]
                if isinstance(val, str):
                    import json
                    return json.loads(val)
                return dict(val)
            return {"brokers": 0, "observations": 0}
        except Exception:
            return {"brokers": 0, "observations": 0}

    # ── Observations / Brokers Feed ──────────────────────────────────────

    def get_observations_feed(self, limit: int = 50, offset: int = 0,
                              broker_key: str = "", intent: str = "") -> list[dict]:
        if broker_key:
            parsed_rows = self._get_parsed_observations_for_broker(
                limit, offset, broker_key=broker_key, intent=intent
            )
            if parsed_rows:
                return parsed_rows

        try:
            data = self.db.execute(
                """SELECT public.get_observations_feed(
                    $1, $2, $3, $4, $5::uuid
                )""",
                (limit, offset, broker_key, intent, self._tenant_id or None),
            ).fetchone()
            if data:
                val = data[0]
                if isinstance(val, str):
                    rows = json.loads(val)
                else:
                    rows = list(val) if val else []
                for r in rows:
                    if isinstance(r.get("evidence_list"), str):
                        r["evidence_list"] = json.loads(r["evidence_list"])
                    elif r.get("evidence_list") is None:
                        r["evidence_list"] = []
                    r.setdefault("raw_message", "")
                    r.setdefault("raw_sender", "")
                if rows:
                    return rows
        except Exception:
            pass

        if broker_key:
            return self._get_parsed_observations_for_broker(
                limit, offset, broker_key=broker_key, intent=intent
            )
        return []

    def _get_parsed_observations_for_broker(self, limit: int = 50, offset: int = 0,
                                            broker_key: str = "", intent: str = "") -> list[dict]:
        if not broker_key:
            return []
        cutoff = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
        normalized_key = _normalize_india_phone(broker_key)
        name_key = broker_key.replace("name:", "", 1).strip().lower()

        query = self.client.table("parsed_output")\
            .select("id,raw_message_id,message_type,intent,bhk,price,price_unit,area_sqft,furnishing,location_raw,building_name,landmark_name,micro_market,broker_name,broker_phone,profile_name,listing_index,confidence,summary_title,normalized_message,created_at,raw_messages(*)")\
            .gte("created_at", cutoff)\
            .order("created_at", desc=True)\
            .limit(limit + offset)
        if self._tenant_id:
            query = query.eq("tenant_id", self._tenant_id)
        if intent:
            query = query.eq("intent", intent.upper())

        result = []
        for parsed in (query.execute().data or []):
            raw = parsed.get("raw_messages") or {}
            if not _is_market_group_name(raw.get("group_name") or ""):
                continue
            phone = (
                _normalize_india_phone(parsed.get("broker_phone") or "")
                or _normalize_india_phone(raw.get("sender_phone") or "")
                or _normalize_india_phone((raw.get("sender_jid") or "").split("@")[0])
            )
            name = (
                _clean_person_name(parsed.get("broker_name") or "")
                or _clean_person_name(parsed.get("profile_name") or "")
                or _clean_person_name(raw.get("sender") or "")
            )
            if normalized_key:
                if phone != normalized_key:
                    continue
            elif name_key and name.lower() != name_key:
                continue
            else:
                continue

            seen_at = raw.get("timestamp") or parsed.get("created_at")
            intent_value = (parsed.get("intent") or "").upper()
            observation_type = (
                "REQUIREMENT"
                if intent_value in {"BUY", "BUYER", "REQUIREMENT", "RENTAL_SEEKER"}
                else "LISTING"
            )
            result.append({
                "id": parsed.get("id"),
                "fingerprint": f"parsed:{parsed.get('id')}",
                "broker_key": phone or f"name:{name.lower()}",
                "summary_title": parsed.get("summary_title") or parsed.get("normalized_message") or raw.get("message") or "",
                "observation_type": observation_type,
                "intent": parsed.get("intent"),
                "bhk": parsed.get("bhk"),
                "price": parsed.get("price"),
                "price_unit": parsed.get("price_unit"),
                "area_sqft": parsed.get("area_sqft"),
                "furnishing": parsed.get("furnishing"),
                "property_type": parsed.get("message_type"),
                "building_name": parsed.get("building_name"),
                "micro_market": parsed.get("micro_market"),
                "location_raw": parsed.get("location_raw"),
                "listing_index": parsed.get("listing_index"),
                "first_seen": seen_at,
                "last_seen": seen_at,
                "times_seen": 1,
                "evidence_list": [{
                    "type": "group",
                    "source": raw.get("group_name") or "",
                    "seen_at": seen_at,
                }],
                "latest_raw_message_id": parsed.get("raw_message_id"),
                "latest_parsed_id": parsed.get("id"),
                "raw_message": raw.get("message") or "",
                "raw_sender": raw.get("sender") or name,
                "broker_name": name,
                "broker_phone": phone,
            })

        return result[offset:offset + limit]

    def get_brokers_feed(self, limit: int = 50, offset: int = 0,
                         min_observations: int = 1) -> list[dict]:
        try:
            parsed_threads = self._get_parsed_market_threads(limit, offset, tenant_id=self._tenant_id)
            result = []
            for thread in parsed_threads:
                identity = thread.get("conversation_key") or thread.get("chat_id") or ""
                phone = _normalize_india_phone(thread.get("broker_phone") or "")
                result.append({
                    "id": identity,
                    "identity_key": identity,
                    "primary_phone": phone or identity,
                    "canonical_name": thread.get("broker_name") or thread.get("conversation_name") or "Unknown broker",
                    "building_count": 1 if thread.get("building_name") else 0,
                    "active_days_30": None,
                    "observation_count": thread.get("opportunity_count") or thread.get("message_count") or 0,
                    "listing_count": thread.get("listing_count") or 0,
                    "requirement_count": thread.get("requirement_count") or 0,
                    "obs_count": thread.get("opportunity_count") or thread.get("message_count") or 0,
                    "last_active": thread.get("latest_message_at") or thread.get("timestamp") or thread.get("created_at"),
                    "first_seen": None,
                    "group_evidence_count": len(thread.get("source_group_names") or []),
                    "dm_evidence_count": 0,
                    "unique_channel_count": len(thread.get("source_group_names") or []),
                    "latest_title": thread.get("summary_title") or thread.get("message"),
                    "latest_intent": thread.get("intent") or thread.get("parsed_intent"),
                    "latest_micro_market": thread.get("micro_market"),
                    "channels": [
                        {"source": group_name, "type": "group"}
                        for group_name in (thread.get("source_group_names") or [])
                    ],
                })
            if result:
                return result
        except Exception:
            pass

        try:
            tid = self._tenant_id
            # tenant_filter = "AND b.tenant_id = $4::uuid" if tid else ""
            tenant_filter = ""
            params = [min_observations, limit, offset]
            if tid:
                params.append(tid)
            rows = self.db.execute(
                f"""SELECT
                       b.id, b.identity_key, b.primary_phone, b.canonical_name,
                       b.building_count, b.active_days_30, b.observation_count,
                       b.listing_count, b.requirement_count,
                       COUNT(DISTINCT o.id) AS obs_count,
                       MAX(o.last_seen) AS last_active,
                       MIN(o.first_seen) AS first_seen,
                       SUM(CASE WHEN oe.evidence_type = 'group' THEN 1 ELSE 0 END) AS group_evidence_count,
                       SUM(CASE WHEN oe.evidence_type = 'dm' THEN 1 ELSE 0 END) AS dm_evidence_count,
                       COUNT(DISTINCT oe.source_conversation) AS unique_channel_count,
                       (SELECT o2.summary_title FROM observations o2
                         WHERE right(o2.broker_key, 10) = b.primary_phone
                         ORDER BY o2.last_seen DESC LIMIT 1) AS latest_title,
                        (SELECT o2.intent FROM observations o2
                         WHERE right(o2.broker_key, 10) = b.primary_phone
                         ORDER BY o2.last_seen DESC LIMIT 1) AS latest_intent,
                        COALESCE(
                            (SELECT json_agg(DISTINCT json_build_object(
                                'source', oe2.source_conversation,
                                'type', oe2.evidence_type
                            ))
                             FROM observation_evidence oe2
                             JOIN observations o2 ON o2.id = oe2.observation_id
                             WHERE right(o2.broker_key, 10) = b.primary_phone),
                            '[]'::json
                        ) AS channels
                    FROM brokers b
                    JOIN observations o ON right(o.broker_key, 10) = b.primary_phone
                    JOIN observation_evidence oe ON oe.observation_id = o.id
                    WHERE b.observation_count >= $1
                      AND b.is_hidden = false
                      {tenant_filter}
                   GROUP BY b.id, b.identity_key, b.primary_phone, b.canonical_name,
                            b.building_count, b.active_days_30, b.observation_count,
                            b.listing_count, b.requirement_count
                   ORDER BY last_active DESC
                   LIMIT $2 OFFSET $3""",
                tuple(params),
            ).fetchall()

            result = []
            for r in rows:
                d = dict(r)
                d["group_evidence_count"] = d.get("group_evidence_count") or 0
                d["dm_evidence_count"] = d.get("dm_evidence_count") or 0
                d["unique_channel_count"] = d.get("unique_channel_count") or 0
                d["building_count"] = d.get("building_count") or 0
                d["active_days_30"] = d.get("active_days_30") or 0
                ch = d.get("channels")
                d["channels"] = json.loads(ch) if isinstance(ch, str) else (ch or [])
                result.append(d)
            return result
        except Exception:
            return []

    def get_saved_inbox_views(self) -> list[dict]:
        try:
            res = self.client.table("saved_inbox_views")\
                .select("id, slug, name, description, filters, is_default, is_shared, created_at, updated_at")\
                .order("is_default", desc=True)\
                .order("name", desc=False)\
                .execute()
            return res.data if res.data else []
        except Exception:
            return []

    def get_building_profile(self, building_db_id: int) -> dict:
        """Get full building profile with stats."""
        try:
            # Get building by database ID
            building_res = self.client.table("buildings").select("*").eq("id", building_db_id).limit(1).execute()
            if not building_res.data:
                return None
            building = building_res.data[0]
            
            # Get aliases
            aliases_res = self.client.table("building_name_aliases").select("*").eq("building_id", building["id"]).execute()
            aliases = aliases_res.data if aliases_res.data else []
            
            # Get enrichment sources
            sources_res = self.client.table("building_enrichment_sources").select("*").eq("building_id", building["id"]).order("enriched_at", desc=True).execute()
            sources = sources_res.data if sources_res.data else []
            
            # Get enrichment history
            history_res = self.client.table("building_enrichment_history").select("*").eq("building_id", building["id"]).order("created_at", desc=True).limit(50).execute()
            history = history_res.data if history_res.data else []
            
            # Get observed listings count
            listings_res = self.client.table("listings").select("id", count="exact").eq("building_name", building["canonical_name"]).execute()
            listings_count = listings_res.count or 0
            
            # Get observed brokers count
            brokers_res = self.client.table("parsed_output").select("broker_name", count="exact").eq("building_name", building["canonical_name"]).not_.is_("broker_name", "null").neq("broker_name", "").execute()
            brokers_count = brokers_res.count or 0
            
            # Get observed requirements count
            req_res = self.client.table("parsed_output").select("id", count="exact").eq("building_name", building["canonical_name"]).in_("intent", ["BUY", "RENTAL_SEEKER", "BUYER", "REQUIREMENT"]).execute()
            requirements_count = req_res.count or 0
            
            # Get price stats
            price_stats_res = self.client.table("price_stats").select("*").eq("micro_market", building.get("micro_market")).execute()
            price_stats = price_stats_res.data if price_stats_res.data else []
            
            # Get landmarks
            landmarks_res = self.client.table("building_landmarks").select("*,landmarks!inner(*)").eq("building_id", building["id"]).execute()
            landmarks = landmarks_res.data if landmarks_res.data else []
            
            # Get markets
            markets_res = self.client.table("building_landmarks").select("landmarks!inner(micro_market)").eq("building_id", building["id"]).execute()
            market_set = set()
            if markets_res.data:
                for m in markets_res.data:
                    if m.get("landmarks") and m["landmarks"].get("micro_market"):
                        market_set.add(m["landmarks"]["micro_market"])
            markets = list(market_set)
            
            return {
                **building,
                "aliases": aliases,
                "sources": sources,
                "history": history,
                "observed_listings": listings_count,
                "observed_brokers": brokers_count,
                "observed_requirements": requirements_count,
                "price_stats": price_stats,
                "landmarks": landmarks,
                "markets": [{"micro_market": m} for m in markets],
            }
        except Exception as e:
            print(f"Error getting building profile: {e}")
            return None

    def get_broker_summary(self, name: str = "", phone: str = "") -> dict:
        """On-the-fly broker summary from listings table."""
        try:
            empty = {"total_listings": 0, "intents": {}, "top_bhk": [], "markets": [], "price_range_sale": "", "price_range_rent": ""}
            if not name and not phone:
                return empty
            
            # Query listings for this broker
            query = self.client.table("listings").select("intent, bhk, price, price_unit, micro_market, observation_count")
            if name:
                query = query.ilike("broker_name", f"%{name}%")
            if phone:
                query = query.ilike("broker_phone", f"%{phone}%")
            
            res = query.execute()
            rows = res.data if res.data else []
            
            total = len(rows)
            intents = {}
            bhk_dist = {}
            markets = {}
            prices_sale = []
            prices_rent = []
            
            for r in rows:
                intent = r["intent"] or "UNKNOWN"
                intents[intent] = intents.get(intent, 0) + 1
                bhk = r["bhk"] or "?"
                bhk_dist[bhk] = bhk_dist.get(bhk, 0) + 1
                market = r["micro_market"] or "?"
                markets[market] = markets.get(market, 0) + 1
                if r["price"] and r["price_unit"]:
                    p = float(r["price"])
                    if intent in ("RENT", "LEASE"):
                        prices_rent.append(p)
                    else:
                        prices_sale.append(p)
            
            def _fmt_price_range(prices: list[float]) -> str:
                if not prices:
                    return ""
                prices.sort()
                if len(prices) == 1:
                    return f"₹{prices[0]:,.0f}"
                return f"₹{prices[0]:,.0f} – ₹{prices[-1]:,.0f}"
            
            top_markets = sorted(markets, key=markets.__getitem__, reverse=True)[:3]
            top_bhk = sorted(bhk_dist, key=bhk_dist.__getitem__, reverse=True)[:3]
            
            return {
                "total_listings": total,
                "intents": intents,
                "top_bhk": top_bhk,
                "markets": top_markets,
                "price_range_sale": _fmt_price_range(prices_sale),
                "price_range_rent": _fmt_price_range(prices_rent),
            }
        except Exception as e:
            print(f"Error getting broker summary: {e}")
            return empty


