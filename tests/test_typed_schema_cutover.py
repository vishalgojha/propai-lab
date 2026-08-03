from storage.supabase import SupabaseStorage, _typed_route
from storage.base import ParsedObservation


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, client, table):
        self.client = client
        self.table = table

    def select(self, *args, **kwargs): return self
    def eq(self, *args, **kwargs): return self
    def limit(self, *args, **kwargs): return self
    def upsert(self, payload, **kwargs):
        self.client.writes.append((self.table, payload, kwargs))
        return self
    def insert(self, payload, **kwargs):
        self.client.writes.append((self.table, payload, kwargs))
        return self
    def execute(self): return _Result([{"id": 101}])


class _Client:
    def __init__(self): self.writes = []
    def table(self, name): return _Query(self, name)


def _storage():
    storage = SupabaseStorage.__new__(SupabaseStorage)
    storage._client = _Client()
    storage._tenant_id = "tenant-a"
    return storage


def test_route_separates_rent_supply_and_sale_demand():
    assert _typed_route({"asset_type": "residential", "transaction_type": "rent"})[0] == "residential_rent_listings"
    assert _typed_route({"asset_type": "commercial", "transaction_type": "sale", "message_type": "requirement"})[0] == "commercial_sale_requirements"
    assert _typed_route({
        "asset_type": "residential",
        "transaction_type": "sale",
        "message_type": "requirement",
        "normalized_message": "Require 3 BHK on lease in Worli",
    })[0] == "residential_rent_requirements"


def test_save_parsed_writes_directly_to_typed_rent_table():
    storage = _storage()
    source_id = storage.save_parsed(ParsedObservation(
        raw_message_id=77,
        listing_index=0,
        asset_type="residential",
        transaction_type="rent",
        intent="RENT",
        bhk="3 BHK",
        price=2.5,
        price_unit="lakh",
        area_sqft=1200,
        location_raw="Bandra West",
        broker_name="Broker A",
    ))
    assert source_id == 77001
    assert len(storage.client.writes) == 1
    table, payload, options = storage.client.writes[0]
    assert table == "residential_rent_listings"
    assert payload["id"] == 77001
    assert payload["legacy_source_id"] == 77001
    assert payload["monthly_rent"] == 250000
    assert payload["bhk"] == 3.0
    assert options["on_conflict"] == "source_fingerprint"
