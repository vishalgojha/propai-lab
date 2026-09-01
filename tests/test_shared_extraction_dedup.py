"""Tests for cross-tenant extraction-result reuse bookkeeping."""

from types import SimpleNamespace

from extraction_dedup import _cache_hash, shared_cache_lookup, shared_cache_store


PAYLOAD = {
    "extraction_source": "ai",
    "provider_used": "grid",
    "extractions": [{"listing_type": "rent", "bhk": 2}],
}


class _Query:
    def __init__(self, client, table):
        self.client = client
        self.table_name = table
        self.filters = {}
        self.payload = None

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, key, value):
        self.filters[key] = value
        return self

    def limit(self, _value):
        return self

    def upsert(self, payload, **_kwargs):
        self.payload = payload
        self.client.upserts.append((self.table_name, payload))
        if self.table_name == "shared_extraction_results":
            self.client.rows = [{"id": 9, **payload}]
        return self

    def execute(self):
        if self.table_name == "shared_extraction_results":
            rows = [
                row for row in self.client.rows
                if all(row.get(key) == value for key, value in self.filters.items())
            ]
        else:
            rows = []
        return SimpleNamespace(data=rows)


class _Client:
    def __init__(self, rows=None):
        self.rows = rows or []
        self.upserts = []
        self.rpcs = []

    def table(self, name):
        return _Query(self, name)

    def rpc(self, name, params):
        self.rpcs.append((name, params))
        return _Query(self, "rpc")


class _Storage:
    def __init__(self, rows=None):
        self.client = _Client(rows)


def test_shared_lookup_records_reuse_without_tenant_leakage():
    storage = _Storage([{
        "id": 9,
        "content_hash": _cache_hash("2 BHK rent Bandra West 85000 carpet 900 sqft"),
        "extraction": PAYLOAD,
        "provider_used": "grid",
        "item_count": 1,
    }])

    result = shared_cache_lookup(
        storage,
        "2 BHK rent Bandra West 85000 carpet 900 sqft",
        raw_message_id=701,
        tenant_id="tenant-b",
    )

    assert result == PAYLOAD
    assert storage.client.rpcs == [("increment_shared_extraction_hit", {"p_id": 9})]
    assert storage.client.upserts[0][0] == "shared_extraction_observations"
    assert storage.client.upserts[0][1]["outcome"] == "reused"
    assert storage.client.upserts[0][1]["tenant_id"] == "tenant-b"


def test_shared_store_records_origin_and_rejects_non_ai_output():
    storage = _Storage()
    shared_cache_store(
        storage,
        "2 BHK rent Bandra West 85000 carpet 900 sqft",
        PAYLOAD,
        raw_message_id=702,
        tenant_id="tenant-a",
    )

    assert storage.client.upserts[0][0] == "shared_extraction_results"
    assert storage.client.upserts[1][0] == "shared_extraction_observations"
    assert storage.client.upserts[1][1]["outcome"] == "origin"

    before = len(storage.client.upserts)
    shared_cache_store(
        storage,
        "2 BHK rent Bandra West 85000 carpet 900 sqft",
        {"extraction_source": "ai_unavailable", "extractions": []},
    )
    assert len(storage.client.upserts) == before
