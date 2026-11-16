"""Boundary tests for the account-free public agent API (routers/public_agent).

These tests pin the privacy contract: the surface reads only the SQL-gated
public market view, applies the website's title-eligibility gate, and never
returns contact fields.
"""
import sys
import types

from datetime import datetime, timedelta, timezone

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient


class FakeQuery:
    def __init__(self, client, table):
        self.client = client
        self.table = table
        self.calls = []
        self._rows = list(client.rows)

    def select(self, columns):
        self.calls.append(("select", columns))
        return self

    def eq(self, column, value):
        self.calls.append(("eq", column, value))
        self._rows = [row for row in self._rows if row.get(column) == value]
        return self

    def gte(self, column, value):
        self.calls.append(("gte", column, value))
        return self

    def lte(self, column, value):
        self.calls.append(("lte", column, value))
        return self

    def ilike(self, column, value):
        self.calls.append(("ilike", column, value))
        return self

    def or_(self, expression):
        self.calls.append(("or", expression))
        return self

    def order(self, column, desc=False):
        self.calls.append(("order", column, desc))
        return self

    def limit(self, value):
        self.calls.append(("limit", value))
        return self

    def offset(self, value):
        self.calls.append(("offset", value))
        return self

    def execute(self):
        self.client.executed.append(self)
        return types.SimpleNamespace(data=self._rows)


class FakeClient:
    def __init__(self, rows):
        self.rows = rows
        self.executed = []

    def table(self, name):
        query = FakeQuery(self, name)
        self.last_table = name
        return query


def make_client(rows):
    fake = FakeClient(rows)
    import routers.common as common

    common.storage = types.SimpleNamespace(client=fake)
    sys.modules.pop("routers.public_agent", None)
    import routers.public_agent as public_agent

    app = FastAPI()
    app.include_router(public_agent.router)
    return TestClient(app), fake


def _iso(days_ago: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days_ago)).isoformat()


SAMPLE_ROW = {
    "card_type": "residential_rent",
    "id": 42,
    "summary_title": "2 BHK in Bandra West",
    "building_name": "Rose Apartments",
    "micro_market": "Bandra West",
    "location_label": "Bandra West",
    "locality_resolved": "Bandra West",
    "bhk": 2,
    "area_sqft": 850,
    "price": 110000,
    "price_unit": "month",
    "price_model": None,
    "furnishing": "Furnished",
    "asset_type": "residential",
    "property_type": "residential",
    "intent": "rent",
    "transaction_type": "rent",
    "deal_tags": ["negotiable"],
    "first_seen": _iso(15),
    "last_seen": _iso(1),
    "observation_count": 3,
    "broker_name": "A Shah",
}


def test_search_only_reads_public_market_view():
    client, fake = make_client([SAMPLE_ROW])
    resp = client.get("/api/public/v1/listings/search")
    assert resp.status_code == 200
    assert fake.last_table == "listings_unified_public"
    data = resp.json()
    assert data["count"] == 1
    item = data["results"][0]
    assert item["public_url"] == "https://www.propai.live/listings/42/42"


def test_search_excludes_placeholder_and_missing_titles():
    rows = [
        SAMPLE_ROW,
        {**SAMPLE_ROW, "id": 43, "summary_title": "[unstructured] 2 bhk bandra"},
        {**SAMPLE_ROW, "id": 44, "summary_title": ""},
        {**SAMPLE_ROW, "id": 45, "summary_title": "[Listing]"},
    ]
    client, _ = make_client(rows)
    data = client.get("/api/public/v1/listings/search").json()
    assert [r["id"] for r in data["results"]] == [42]


def test_response_has_no_contact_or_private_fields():
    client, _ = make_client([SAMPLE_ROW])
    item = client.get("/api/public/v1/listings/search").json()["results"][0]
    forbidden = [key for key in item if any(word in key for word in ("phone", "contact_number", "whatsapp_number", "raw_payload", "raw_message", "sender", "tenant"))]
    assert forbidden == []
    assert item["broker_name"] == "A Shah"


def test_filters_are_applied_to_query():
    client, fake = make_client([SAMPLE_ROW])
    client.get("/api/public/v1/listings/search?locality=Bandra%20West&bhk=2&transaction_type=rent&budget_max=150000&q=Rose")
    query = fake.executed[-1]
    assert ("eq", "bhk", 2.0) in query.calls
    assert ("eq", "transaction_type", "rent") in query.calls
    assert ("lte", "price", 150000) in query.calls
    or_clauses = [c for c in query.calls if c[0] == "or"]
    assert len(or_clauses) == 2  # q + locality
    assert "building_name.ilike.%Rose%" in or_clauses[0][1]


def test_search_enforces_30_day_freshness_window():
    rows = [
        SAMPLE_ROW,  # fresh
        {**SAMPLE_ROW, "id": 43, "last_seen": _iso(45)},  # stale
        {**SAMPLE_ROW, "id": 44, "last_seen": None},  # no observation time
    ]
    client, fake = make_client(rows)
    data = client.get("/api/public/v1/listings/search").json()
    # Fake storage ignores gte(), so this proves the exclusion is enforced in
    # the route code, not delegated to the database or the view.
    assert [r["id"] for r in data["results"]] == [42]
    gte_calls = [c for c in fake.executed[-1].calls if c[0] == "gte" and c[1] == "last_seen"]
    assert gte_calls, "search must push the freshness cutoff into the query too"
    cutoff = datetime.fromisoformat(gte_calls[0][2].replace("Z", "+00:00"))
    age_days = (datetime.now(timezone.utc) - cutoff).days
    assert age_days == 30


def test_detail_marks_old_listing_inactive_but_reachable():
    rows = [
        SAMPLE_ROW,
        {**SAMPLE_ROW, "id": 43, "card_type": "commercial_sale", "last_seen": _iso(120)},
    ]
    client, _ = make_client(rows)
    fresh = client.get("/api/public/v1/listings/42").json()["results"][0]
    assert fresh["active"] is True
    stale = client.get("/api/public/v1/listings/43?card_type=commercial_sale").json()["results"][0]
    assert stale["active"] is False


def test_detail_404_for_placeholder_title():
    client, _ = make_client([{**SAMPLE_ROW, "summary_title": "[unknown]"}])
    resp = client.get("/api/public/v1/listings/42")
    assert resp.status_code == 404


def test_detail_404_when_absent():
    client, _ = make_client([])
    resp = client.get("/api/public/v1/listings/999")
    assert resp.status_code == 404


def test_detail_returns_listing_without_contacts():
    client, _ = make_client([SAMPLE_ROW])
    data = client.get("/api/public/v1/listings/42").json()
    assert data["count"] == 1
    assert "WhatsApp" in data["results"][0]["contact"]


def test_docs_is_instructions_only():
    client, _ = make_client([])
    resp = client.get("/api/public/v1/docs")
    assert resp.status_code == 200
    assert "listings/search" in resp.text
    assert "read-only" in resp.text
