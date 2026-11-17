import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException

from registry.search_locality import resolve_search_locality, AmbiguousLocality
from routers import external_agent
from storage.supabase import SupabaseStorage


REFERENCE = [
    {"id": 1, "sub_locality": "Bandra West", "parent_locality": "Mumbai", "canonical_locality": "Bandra West", "alternate_names": ["Bandra W"]},
    {"id": 2, "sub_locality": "Pali Hill", "parent_locality": "Bandra West", "canonical_locality": "Bandra West", "alternate_names": ["Pali Hills"]},
    {"id": 3, "sub_locality": "Carter Road", "parent_locality": "Bandra West", "alternate_names": ["Carter Rd"]},
    {"id": 4, "sub_locality": "Bandra East", "parent_locality": "Mumbai"},
    {"id": 5, "sub_locality": "BKC", "parent_locality": "Bandra East"},
]


def test_broad_parent_reuses_only_reference_descendants():
    scope = resolve_search_locality("Bandra West", REFERENCE)
    assert scope.locality_ids == (1, 2, 3)
    assert "Carter Rd" in scope.labels
    assert "BKC" not in scope.labels
    assert scope.status == "reference_descendants"


def test_child_or_alias_never_expands_to_parent_siblings():
    for name in ("Pali Hill", "Pali Hills"):
        scope = resolve_search_locality(name, REFERENCE)
        assert scope.locality_ids == (2,)
        assert "Bandra West" not in scope.labels
        assert "Carter Road" not in scope.labels


def test_parent_alias_resolves_same_scope():
    assert resolve_search_locality("Bandra W", REFERENCE).locality_ids == (1, 2, 3)


def test_unknown_area_stays_exact_without_guessing():
    scope = resolve_search_locality("Some New Pocket", REFERENCE)
    assert scope.status == "exact_unmapped"
    assert scope.labels == ("Some New Pocket",)
    assert not scope.locality_ids


def test_ambiguous_alias_fails_instead_of_guessing():
    rows = REFERENCE + [{"id": 6, "sub_locality": "Another Pali", "parent_locality": "Thane", "alternate_names": ["Pali Hills"]}]
    with pytest.raises(AmbiguousLocality):
        resolve_search_locality("Pali Hills", rows)


def test_unknown_parent_without_own_row_can_expand_reference_children():
    assert resolve_search_locality("Mumbai", REFERENCE).locality_ids == (1, 2, 3, 4, 5)


def test_filter_uses_relational_identity_and_exact_text_not_buildings():
    expression = resolve_search_locality("Pali Hill", REFERENCE).postgrest_filter()
    assert "locality_id.in.(2)" in expression
    assert 'and(locality_id.is.null,or(' in expression
    assert 'micro_market.ilike."Pali Hill"' in expression
    assert "building_name" not in expression
    assert "%" not in expression


@pytest.mark.parametrize("name", ["Pali%", "Bandra*", "", "x\ny"])
def test_wildcards_and_invalid_names_fail(name):
    with pytest.raises(ValueError):
        resolve_search_locality(name, REFERENCE)


def _storage(rows):
    calls = []
    class Query:
        def __init__(self, table):
            self.table = table
            self.operations = []
            self.n = 1000
        def select(self, *args):
            return self
        def or_(self, value):
            self.operations.append(("locality", value)); return self
        def eq(self, field, value):
            self.operations.append((field, value)); return self
        def order(self, *args, **kwargs):
            self.operations.append(("order", args)); return self
        def limit(self, n):
            self.operations.append(("limit", n)); self.n = n; return self
        def execute(self):
            calls.append((self.table, self.operations))
            selected = rows if self.table == "residential_rent_listings" else []
            if any(k == "locality" for k, _ in self.operations):
                selected = [r for r in selected if r.get("locality_id") == 2]
            return SimpleNamespace(data=selected[:self.n])
    store = object.__new__(SupabaseStorage)
    store._client = SimpleNamespace(table=lambda table: Query(table))
    store._attach_source_sender_identity = lambda rows, **kw: rows
    store._attach_locality_hierarchy = lambda rows: rows
    store._typed_row_to_legacy = lambda row: dict(row)
    return store, calls


def _row(i, locality_id=2, price=100000):
    return {"id": i, "locality_id": locality_id, "message_type": "listing", "price": price,
            "bhk": 2, "transaction_type": "rent", "created_at": f"2026-01-01T00:00:{i%60:02d}Z",
            "building_name": f"Building {i}", "raw_message_id": 0}


def test_locality_filter_reaches_query_before_limit_and_keeps_tenant():
    store, calls = _storage([_row(i, 4) for i in range(300)] + [_row(500)])
    rows = store.get_parsed(limit=1, kind="listing", assistant_search={
        "tenant_id": "owner-tenant", "locality_scope": resolve_search_locality("Pali Hill", REFERENCE),
        "transaction_type": "rent", "bhk": 2,
    })
    assert [r["id"] for r in rows] == [500]
    for table, operations in calls:
        assert table == "residential_rent_listings"
        assert ("tenant_id", "owner-tenant") in operations
        assert next(i for i, (k, _) in enumerate(operations) if k == "locality") < next(i for i, (k, _) in enumerate(operations) if k == "limit")


def test_normalized_budget_filters_before_final_pagination():
    store, _ = _storage([_row(1, price=200000), _row(2, price=90000)])
    rows = store.get_parsed(limit=1, kind="listing", assistant_search={"tenant_id": "t", "transaction_type": "rent", "budget_max": 100000})
    assert [r["id"] for r in rows] == [2]


def test_new_search_cannot_fall_back_to_unscoped_storage():
    store, calls = _storage([])
    with pytest.raises(ValueError, match="explicit tenant"):
        store.get_parsed(assistant_search={})
    assert calls == []


def test_route_passes_scope_without_widening_grants(monkeypatch):
    fetch = AsyncMock(return_value=[{"id": 8, "micro_market": "Pali Hill"}])
    monkeypatch.setattr(external_agent, "_tenant_parsed", fetch)
    monkeypatch.setattr(external_agent, "_fetch_all", lambda *args: REFERENCE)
    monkeypatch.setattr(external_agent, "storage", SimpleNamespace(client=object()))
    monkeypatch.setattr(external_agent, "_record_assistant_trial_start", lambda *args: None)
    result = asyncio.run(external_agent.external_listing_search(locality="Bandra West", bhk="2.5", limit=20, offset=0, key={"tenant_id": "t", "scopes": ["inventory:read"]}))
    args = fetch.call_args.kwargs["assistant_search"]
    assert args["tenant_id"] == "t"
    assert args["bhk"] == 2.5
    assert args["locality_scope"].locality_ids == (1, 2, 3)
    assert result["results"][0]["micro_market"] == "Pali Hill"
    assert result["search_scope"]["exhaustive"] is False


def test_denied_key_never_reads_reference_or_inventory(monkeypatch):
    monkeypatch.setattr(external_agent, "_fetch_all", lambda *args: pytest.fail("No reference access"))
    with pytest.raises(HTTPException) as error:
        asyncio.run(external_agent.external_listing_search(locality="Bandra West", key={"tenant_id": "t", "scopes": []}))
    assert error.value.status_code == 403


def test_reference_failure_returns_unavailable_not_zero(monkeypatch):
    monkeypatch.setattr(external_agent, "storage", SimpleNamespace(client=object()))
    def fail(*args):
        raise RuntimeError("Reference offline")
    monkeypatch.setattr(external_agent, "_fetch_all", fail)
    with pytest.raises(HTTPException) as error:
        asyncio.run(external_agent.external_listing_search(locality="Bandra West", key={"tenant_id": "t", "scopes": ["inventory:read"]}))
    assert error.value.status_code == 503


def test_product_knowledge_reuses_glossary_without_workspace_data():
    from domain_glossary import build_ai_domain_context
    response = asyncio.run(external_agent.external_agent_knowledge())
    assert response.body.decode() == build_ai_domain_context()
    assert "crore" in response.body.decode()


def test_real_rest_client_serializes_scope_and_tenant_before_limit():
    import httpx
    from storage.supabase import _RestClient
    captured = []
    def handler(request):
        captured.append(request)
        return httpx.Response(200, json=[])
    client = _RestClient("https://example.supabase.co", "not-a-real-key")
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    scope = resolve_search_locality("Bandra West", REFERENCE)
    client.table("residential_rent_listings").select("id").or_(scope.postgrest_filter()).eq("tenant_id", "owner-tenant").limit(250).execute()
    query = captured[0].url.params
    assert query["tenant_id"] == "eq.owner-tenant"
    assert query["limit"] == "250"
    assert "locality_id.in.(1,2,3)" in query["or"]
    assert "Bandra East" not in query["or"]


def test_same_child_name_under_two_parents_is_ambiguous():
    rows = REFERENCE + [{"id": 20, "sub_locality": "Pali Hill", "parent_locality": "Another City"}]
    with pytest.raises(AmbiguousLocality):
        resolve_search_locality("Pali Hill", rows)


def test_missing_carter_relationship_does_not_get_invented():
    scope = resolve_search_locality("Bandra West", [r for r in REFERENCE if r["id"] != 3])
    assert "Carter Road" not in scope.labels


def test_existing_non_assistant_calls_keep_legacy_dataclass_contract():
    from dataclasses import is_dataclass
    store, _ = _storage([])
    store._tenant_id = "t"
    assert store.get_parsed() == []
