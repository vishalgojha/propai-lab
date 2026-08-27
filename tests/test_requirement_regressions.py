"""Regression tests for requirement titles, locality fields, and feed reposts."""

from extraction import _ai_extraction_to_parsed, _title_evidence_mismatch
from extraction_quality import building_name_problem
from routers.infra import generate_summary_title
from storage.supabase import SupabaseStorage, _clean_market_building_name, _merge_observation_rows
from types import SimpleNamespace


def test_requirement_title_uses_budget_bounds_not_listing_price():
    title = generate_summary_title(
        {
            "message_type": "REQUIREMENT",
            "intent": "BUY",
            "asset_type": "residential",
            "bhk": "4 BHK",
            "micro_market": "Bandra West",
            "budget_min": 8_000_000,
            "budget_max": 8_000_000,
            # A provider must not be able to influence this requirement title
            # through a stray listing-schema field.
            "price": 800_000,
            "price_unit": "abs",
        },
        "Looking to buy a 4 BHK in Bandra West",
    )
    assert "₹80 Lakh" in title
    assert "₹8 Lakh" not in title


def test_requirement_title_can_show_a_budget_range():
    title = generate_summary_title(
        {
            "message_type": "REQUIREMENT",
            "intent": "BUY",
            "asset_type": "residential",
            "bhk": "4 BHK",
            "budget_min": 5_000_000,
            "budget_max": 8_000_000,
        },
        "4 BHK buyer requirement, budget 50 to 80 lakh",
    )
    assert "₹50 Lakh–₹80 Lakh" in title


def test_requirement_building_cannot_be_a_locality_corridor():
    assert building_name_problem("Bandra to Santacruz") == "building_name_is_locality_range"
    assert _clean_market_building_name({
        "building_name": "Bandra to Santacruz",
        "micro_market": "Bandra West",
    }) == ""
    parsed = _ai_extraction_to_parsed(
        {
            "listing_type": "requirement",
            "transaction_type": "sale",
            "property_category": "residential",
            "building_name": "Bandra to Santacruz",
            "bhk": 4,
            "budget_min": 8_000_000,
            "budget_max": 8_000_000,
            "locality": {
                "raw_mention": "Bandra to Santacruz",
                "resolved_locality": "Bandra to Santacruz",
            },
            "title": "4 BHK Buyer Requirement",
        },
        "Looking to buy 4 BHK in Bandra to Santacruz, budget 80 lakh",
        "",
        "",
    )
    assert parsed["building_name"] is None
    assert "₹80 Lakh" in parsed["summary_title"]
    assert parsed["total_asking_price"] is None


def test_title_rejects_wrong_transaction_and_order_of_magnitude():
    assert _title_evidence_mismatch(
        "4 BHK for Sale — ₹1500 Cr",
        "4 BHK requirement, rent only Bandra west",
        "Only Bandra west",
        {
            "message_type": "requirement",
            "transaction_type": "rent",
            "budget_min": 150_000_000,
            "budget_max": 150_000_000,
        },
    )


def test_title_rejects_requirement_price_mismatch_even_when_transaction_matches():
    assert _title_evidence_mismatch(
        "4 BHK for Sale — ₹1500 Cr",
        "4 BHK buyer requirement in Bandra West",
        None,
        {
            "message_type": "requirement",
            "transaction_type": "sale",
            "budget_min": 80_000_000,
            "budget_max": 80_000_000,
        },
    )


def test_requirement_title_uses_up_to_and_from_for_single_budget_bound():
    upper = generate_summary_title(
        {"message_type": "REQUIREMENT", "intent": "BUY", "asset_type": "residential", "bhk": "3 BHK", "budget_max": 8_000_000},
        "Looking to buy up to ₹80 lakh",
    )
    lower = generate_summary_title(
        {"message_type": "REQUIREMENT", "intent": "BUY", "asset_type": "residential", "bhk": "3 BHK", "budget_min": 5_000_000},
        "Looking to buy from ₹50 lakh",
    )
    assert "up to ₹80 Lakh" in upper
    assert "from ₹50 Lakh" in lower


def test_shared_feed_collapses_cross_tenant_requirement_reposts():
    rows = []
    for row_id, broker_id in ((1, 101), (2, 202)):
        rows.append(
            {
                "id": row_id,
                "tenant_id": f"tenant-{row_id}",
                "observation_type": "REQUIREMENT",
                "asset_type": "residential",
                "transaction_type": "sale",
                "broker_id": broker_id,
                "broker_phone": "+919876543210",
                "broker_name": "Sunny Rochlani",
                "bhk": 4,
                "micro_market": "Bandra West",
                "budget_min": 8_000_000,
                "budget_max": 8_000_000,
                "summary_title": "Looking to buy a 4 BHK in Bandra West with a budget of ₹80 Lakh",
                "created_at": f"2026-08-25T0{row_id}:00:00+00:00",
            }
        )
    merged = _merge_observation_rows(rows)
    assert len(merged) == 1
    assert merged[0]["times_seen"] == 2


def test_requirement_duplicate_search_crosses_tenants_but_updates_each_tenant_scope():
    candidate = {
        "id": 1,
        "tenant_id": "tenant-original",
        "asset_type": "residential",
        "transaction_type": "sale",
        "bhk": 4,
        "micro_market": "Bandra West",
        "budget_min": 8_000_000,
        "budget_max": 8_000_000,
        "repost_count": 1,
    }
    current = {**candidate, "id": 2, "tenant_id": "tenant-current"}

    class Query:
        def __init__(self, client, table):
            self.client, self.table_name = client, table
            self.action, self.projection, self.filters, self.payload = "select", "*", [], None

        def select(self, projection):
            self.projection = projection
            return self

        def update(self, payload):
            self.action, self.payload = "update", payload
            return self

        def eq(self, field, value):
            self.filters.append((field, "eq", value))
            return self

        def neq(self, field, value):
            self.filters.append((field, "neq", value))
            return self

        def order(self, *args, **kwargs):
            return self

        def limit(self, *args, **kwargs):
            return self

        def in_(self, field, values):
            self.filters.append((field, "in", values))
            return self

        def execute(self):
            self.client.queries.append(self)
            if self.action == "update":
                self.client.updates.append((self.filters, self.payload))
                return SimpleNamespace(data=[])
            if self.projection.startswith("id,tenant_id"):
                return SimpleNamespace(data=[candidate])
            if any(op == "in" for _, op, _ in self.filters):
                return SimpleNamespace(data=[candidate])
            return SimpleNamespace(data=[current])

    class Client:
        def __init__(self):
            self.queries, self.updates = [], []

        def table(self, table):
            return Query(self, table)

    client = Client()
    storage = SupabaseStorage.__new__(SupabaseStorage)
    object.__setattr__(storage, "_client", client)
    result = storage.record_requirement_duplicate(
        2, table="residential_sale_requirements", tenant_id="tenant-current"
    )

    assert result["duplicate_status"] == "flagged"
    assert any(("tenant_id", "eq", "tenant-original") in filters for filters, _ in client.updates)
    assert any(("tenant_id", "eq", "tenant-current") in filters for filters, _ in client.updates)
    candidate_query = next(q for q in client.queries if q.projection.startswith("id,tenant_id"))
    assert not any(field == "tenant_id" for field, _, _ in candidate_query.filters)
