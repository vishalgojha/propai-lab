"""Tests for the client-memory layer (aliases, notes, messages, matching).

These exercise the new SupabaseStorage methods against a small stateful fake
of the PostgREST query builder so the resolution/supersede logic is covered
without a live database.
"""

import pytest

from storage.supabase import SupabaseStorage, set_tenant_id


class _Result:
    def __init__(self, data, count=None):
        self.data = data
        self.count = count


class _Store:
    def __init__(self, tables):
        self.tables = {name: [dict(row) for row in rows] for name, rows in tables.items()}

    def next_id(self, name):
        rows = self.tables.setdefault(name, [])
        return max((int(row.get("id") or 0) for row in rows), default=0) + 1


class _Query:
    def __init__(self, store, table):
        self.store = store
        self.table = table
        self._preds = []
        self._order = None
        self._desc = False
        self._limit = None
        self._offset = 0
        self._count = None
        self._op = "select"
        self._payload = None
        self._cols = None

    def select(self, cols="*", count=None):
        self._op, self._cols, self._count = "select", cols, count
        return self

    def insert(self, payload):
        self._op, self._payload = "insert", payload
        return self

    def update(self, payload):
        self._op, self._payload = "update", payload
        return self

    def eq(self, col, val):
        self._preds.append(lambda row, c=col, v=val: row.get(c) == v)
        return self

    def is_(self, col, val):
        if str(val).lower() == "null":
            self._preds.append(lambda row, c=col: row.get(c) is None)
        else:
            self._preds.append(lambda row, c=col, v=val: row.get(c) == v)
        return self

    def in_(self, col, vals):
        allowed = set(vals)
        self._preds.append(lambda row, c=col, a=allowed: row.get(c) in a)
        return self

    def ilike(self, col, val):
        needle = str(val).strip("%").lower()
        self._preds.append(lambda row, c=col, n=needle: n in str(row.get(c) or "").lower())
        return self

    def or_(self, expr):
        clauses = [part.split(".", 2) for part in expr.split(",")]

        def predicate(row):
            for col, op, val in clauses:
                target = str(row.get(col) or "")
                if op == "ilike" and val.strip("%").lower() in target.lower():
                    return True
                if op == "eq" and (target == val or str(row.get(col)) == str(val)):
                    return True
                if op == "eq" and str(row.get(col)) == val:
                    return True
            return False

        self._preds.append(predicate)
        return self

    def order(self, col, desc=False):
        self._order, self._desc = col, desc
        return self

    def limit(self, n):
        self._limit = n
        return self

    def offset(self, n):
        self._offset = n
        return self

    def execute(self):
        rows = self.store.tables.setdefault(self.table, [])
        if self._op == "insert":
            payload = self._payload if isinstance(self._payload, list) else [self._payload]
            created = []
            for item in payload:
                row = dict(item)
                row.setdefault("id", self.store.next_id(self.table))
                rows.append(row)
                created.append(row)
            return _Result(created)
        if self._op == "update":
            matched = [row for row in rows if all(pred(row) for pred in self._preds)]
            for row in matched:
                row.update(self._payload)
            return _Result(matched)
        matched = [row for row in rows if all(pred(row) for pred in self._preds)]
        if self._order:
            matched = sorted(
                matched,
                key=lambda row: (row.get(self._order) is None, row.get(self._order)),
                reverse=self._desc,
            )
        total = len(matched)
        if self._offset:
            matched = matched[self._offset:]
        if self._limit is not None:
            matched = matched[: self._limit]
        if self._cols and self._cols != "*":
            cols = [part.strip() for part in self._cols.split(",")]
            matched = [{col: row.get(col) for col in cols} for row in matched]
        return _Result(matched, count=total if self._count == "exact" else None)


class _Client:
    def __init__(self, store):
        self.store = store

    def table(self, name):
        self.store.tables.setdefault(name, [])
        return _Query(self.store, name)


def _make_storage(tables, tenant="tenant-1"):
    set_tenant_id(None)
    storage = object.__new__(SupabaseStorage)
    store = _Store(tables)
    storage._client = _Client(store)
    storage._fake_store = store
    storage._tenant_id = tenant
    return storage


@pytest.fixture(autouse=True)
def _reset_tenant():
    yield
    set_tenant_id(None)


def test_create_client_records_name_and_phone_aliases():
    storage = _make_storage({"clients": [], "client_aliases": []})
    client_id = storage.create_client("Ravi Sharma", phone="9820056180")
    assert client_id
    aliases = {row["normalized_alias"] for row in storage._fake_store.tables["client_aliases"]}
    assert {"ravi sharma", "ravi", "9820056180"} <= aliases


def test_add_client_alias_rejects_conflict_across_clients():
    storage = _make_storage({
        "clients": [
            {"id": 1, "name": "Ravi Sharma", "status": "active", "tenant_id": "tenant-1"},
            {"id": 2, "name": "Neha Shah", "status": "active", "tenant_id": "tenant-1"},
        ],
        "client_aliases": [],
    })
    assert storage.add_client_alias(1, "Ravi")
    assert storage.add_client_alias(2, "Ravi") is None
    assert storage.add_client_alias(1, "Ravi") is not None


def test_resolve_client_exact_alias_then_fuzzy():
    storage = _make_storage({
        "clients": [{"id": 7, "name": "Ravi Sharma", "phone": "9820056180", "status": "active", "tenant_id": "tenant-1"}],
        "client_aliases": [
            {"id": 1, "client_id": 7, "alias": "Ravi", "normalized_alias": "ravi", "confidence": 0.92, "tenant_id": "tenant-1"},
        ],
    })
    exact = storage.resolve_client("Ravi")
    assert exact["id"] == 7 and exact["match_method"] == "alias_exact"
    fuzzy = storage.resolve_client("Ravii Sharma")
    assert fuzzy["id"] == 7 and fuzzy["match_method"] == "fuzzy_alias"


def test_resolve_client_strips_invocation_fluff():
    storage = _make_storage({
        "clients": [{"id": 3, "name": "Neha Shah", "phone": "9000000000", "status": "active", "tenant_id": "tenant-1"}],
        "client_aliases": [],
    })
    assert storage.resolve_client("client Neha Shah ji")["id"] == 3


def test_add_client_note_supersedes_previous():
    storage = _make_storage({
        "clients": [{"id": 1, "name": "Ravi", "status": "active", "tenant_id": "tenant-1"}],
        "client_notes": [
            {"id": 11, "client_id": 1, "body": "budget 3cr", "is_active": 1, "created_at": "2026-01-01", "tenant_id": "tenant-1"},
        ],
    })
    storage.add_client_note(1, "budget now 3.5cr", supersedes_note_id=11)
    latest = storage.get_latest_client_note(1)
    assert latest["body"] == "budget now 3.5cr"
    active = storage.get_client_notes(1, active_only=True)
    assert [row["body"] for row in active] == ["budget now 3.5cr"]


def test_get_client_messages_matches_phone_suffix():
    storage = _make_storage({
        "clients": [{"id": 1, "name": "Ravi", "phone": "9820056180", "status": "active", "tenant_id": "tenant-1"}],
        "raw_messages": [
            {"id": 1, "sender_phone": "919820056180", "message": "hi", "timestamp": "2026-01-02", "tenant_id": "tenant-1"},
            {"id": 2, "sender_phone": "919999999999", "message": "spam", "timestamp": "2026-01-03", "tenant_id": "tenant-1"},
        ],
    })
    result = storage.get_client_messages(1)
    assert result["total"] == 1
    assert result["messages"][0]["message"] == "hi"
    assert result["messages"][0]["direction"] == "inbound"


def test_get_all_active_requirements_joins_client_info():
    storage = _make_storage({
        "clients": [
            {"id": 1, "name": "Ravi", "phone": "9820056180", "status": "active", "tenant_id": "tenant-1"},
            {"id": 2, "name": "Gone", "phone": "9000000000", "status": "archived", "tenant_id": "tenant-1"},
        ],
        "client_requirements": [
            {"id": 5, "client_id": 1, "intent": "RENT", "bhk": "3 BHK", "is_primary": True, "tenant_id": "tenant-1"},
            {"id": 6, "client_id": 2, "intent": "BUY", "bhk": "2 BHK", "is_primary": True, "tenant_id": "tenant-1"},
        ],
    })
    requirements = storage.get_all_active_requirements()
    assert len(requirements) == 1
    assert requirements[0]["client_name"] == "Ravi"
    assert requirements[0]["client_phone"] == "9820056180"


def test_get_requirement_matches_attaches_listing():
    storage = _make_storage({
        "requirement_matches": [
            {"id": 1, "requirement_typed_id": 5, "listing_type": "rent_listing", "listing_typed_id": 42, "match_score": 0.9, "bhk_match": True, "tenant_id": "tenant-1"},
            {"id": 2, "requirement_typed_id": 5, "listing_type": "rent_listing", "listing_typed_id": 99, "match_score": 0.5, "tenant_id": "tenant-1"},
        ],
        "listings_unified_matching": [
            {"id": 42, "card_type": "rent_listing", "building_name": "Sea View", "bhk": "3 BHK", "tenant_id": "tenant-1"},
        ],
    })
    matches = storage.get_requirement_matches(5)
    assert len(matches) == 1
    assert matches[0]["listing"]["building_name"] == "Sea View"
    assert matches[0]["match_score"] == 0.9


def test_update_client_updates_name_and_refreshes_alias():
    storage = _make_storage({
        "clients": [{"id": 1, "name": "Ravi", "phone": "9820056180", "status": "active", "tenant_id": "tenant-1"}],
        "client_aliases": [],
    })
    assert storage.update_client(1, name="Ravi Sharma", status="active") is True
    assert storage.resolve_client("Ravi Sharma")["id"] == 1
