"""Tests for cross-tenant extraction-result reuse bookkeeping."""

from types import SimpleNamespace
from datetime import datetime, timedelta, timezone
import httpx

from extraction_dedup import _cache_hash, shared_cache_lookup, shared_cache_store
from storage.supabase import SupabaseStorage


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


def test_shared_reuse_strips_sender_and_source_identity():
    payload = {
        **PAYLOAD,
        "extractions": [{
            "listing_type": "rent",
            "broker_name": "Broker A",
            "broker_phone": "919900001234",
            "contacts": [{"name": "Broker A", "phone": "919900001234"}],
            "source_text": "2 BHK ... Call Broker A 9900001234",
            "nested": {"sender_phone": "919900001234", "verified": True},
        }],
    }
    storage = _Storage([{
        "id": 9,
        "content_hash": _cache_hash("2 BHK rent Bandra West 85000 carpet 900 sqft"),
        "extraction": payload,
        "provider_used": "grid",
        "item_count": 1,
    }])

    result = shared_cache_lookup(
        storage,
        "2 BHK rent Bandra West 85000 carpet 900 sqft",
        raw_message_id=703,
        tenant_id="tenant-b",
    )

    item = result["extractions"][0]
    assert "broker_name" not in item
    assert "broker_phone" not in item
    assert "contacts" not in item
    assert "source_text" not in item
    assert "nested" in item and "sender_phone" not in item["nested"]


def test_shared_store_does_not_mutate_original_payload():
    payload = {
        **PAYLOAD,
        "extractions": [{"broker_phone": "919900001234", "nested": {"phone": "919900001234"}}],
    }
    original = {"extractions": [{"broker_phone": "919900001234", "nested": {"phone": "919900001234"}}], **{k: v for k, v in payload.items() if k != "extractions"}}
    storage = _Storage()

    shared_cache_store(storage, "2 BHK rent Bandra West 85000 carpet 900 sqft", payload)

    assert payload == original


class _ClaimQuery:
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

    def insert(self, payload):
        self.payload = payload
        return self

    def delete(self):
        self.client.delete_queries.append(self)
        return self

    def execute(self):
        if self.table_name == "shared_extraction_claims" and self.payload is not None:
            if any(row.get("content_hash") == self.payload.get("content_hash") for row in self.client.claims):
                raise RuntimeError("409 Conflict: duplicate key")
            self.client.claims.append(dict(self.payload))
            return SimpleNamespace(data=[dict(self.payload)])
        if self.table_name == "shared_extraction_claims":
            if self.client.delete_queries and self.client.delete_queries[-1] is self:
                self.client.claims[:] = [
                    row for row in self.client.claims
                    if not all(row.get(key) == value for key, value in self.filters.items())
                ]
                return SimpleNamespace(data=[])
            rows = [
                row for row in self.client.claims
                if all(row.get(key) == value for key, value in self.filters.items())
            ]
            return SimpleNamespace(data=rows)
        return SimpleNamespace(data=[])


class _ClaimClient:
    def __init__(self, claims=None):
        self.claims = list(claims or [])
        self.delete_queries = []

    def table(self, name):
        return _ClaimQuery(self, name)


def _claim_storage(claims=None):
    storage = SupabaseStorage.__new__(SupabaseStorage)
    storage._client = _ClaimClient(claims)
    storage._tenant_id = "tenant-a"
    return storage


def test_shared_claim_allows_one_winner_and_rejects_concurrent_loser():
    storage = _claim_storage()
    digest = _cache_hash("2 BHK rent Bandra West")

    assert storage.claim_shared_extraction_hash(101, digest, tenant_id="tenant-a") == {
        "claimed": True,
        "first_raw_id": 101,
    }
    assert storage.claim_shared_extraction_hash(202, digest, tenant_id="tenant-b") == {
        "claimed": False,
        "first_raw_id": 101,
    }


def test_shared_claim_reclaims_only_stale_claims():
    digest = _cache_hash("2 BHK rent Bandra West")
    stale = (datetime.now(timezone.utc) - timedelta(minutes=11)).isoformat()
    storage = _claim_storage([{
        "content_hash": digest,
        "first_raw_message_id": 101,
        "tenant_id": "tenant-a",
        "claimed_at": stale,
    }])

    result = storage.claim_shared_extraction_hash(202, digest, tenant_id="tenant-b")

    assert result == {"claimed": True, "first_raw_id": 202}
    assert storage.client.claims[0]["first_raw_message_id"] == 202


def test_missing_claim_table_is_explicitly_reported_for_safe_rollout():
    class MissingQuery:
        def insert(self, _payload):
            return self

        def execute(self):
            request = httpx.Request("POST", "https://example.invalid")
            response = httpx.Response(404, request=request)
            raise httpx.HTTPStatusError("missing table", request=request, response=response)

    class MissingClient:
        def table(self, _name):
            return MissingQuery()

    storage = SupabaseStorage.__new__(SupabaseStorage)
    storage._client = MissingClient()
    storage._tenant_id = "tenant-a"

    result = storage.claim_shared_extraction_hash(303, "digest", tenant_id="tenant-a")

    assert result == {"claimed": False, "first_raw_id": None, "available": False}
