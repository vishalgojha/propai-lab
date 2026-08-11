from storage.supabase import SupabaseStorage


class _Result:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, data):
        self._data = data

    def select(self, *_args, **_kwargs):
        return self

    def limit(self, _limit):
        return self

    def execute(self):
        return _Result(self._data)


class _Client:
    def __init__(self, tables):
        self._tables = tables

    def table(self, name):
        return _Query(self._tables.get(name, []))


def _listing(listing_id, building_name, micro_market, created_at):
    return {
        "id": listing_id,
        "_typed_table": "residential_sale_listings",
        "transaction_type": "sale",
        "asset_type": "residential",
        "building_name": building_name,
        "micro_market": micro_market,
        "created_at": created_at,
        "updated_at": created_at,
    }


def test_market_map_resolves_each_listing_building_independently():
    storage = object.__new__(SupabaseStorage)
    storage._market_reference_cache = None
    storage._client = _Client({
        "buildings": [
            {"id": 1, "canonical_name": "Kabra Paradise", "address": "Malad West", "micro_market": "Malad West", "latitude": 19.1, "longitude": 72.8},
            {"id": 2, "canonical_name": "Rustomjee Paramount", "address": "Khar West", "micro_market": "Khar West", "latitude": 19.0, "longitude": 72.8},
            {"id": 3, "canonical_name": "JVM Aroma", "address": "Thane West", "micro_market": "Thane West", "latitude": 19.2, "longitude": 72.9},
        ],
        "building_name_aliases": [],
    })
    storage._fetch_typed_rows = lambda **_kwargs: [
        _listing(1, "Kabra Paradise", "Malad West", "2026-08-11T03:00:00+00:00"),
        _listing(2, "Rustomjee Paramount", "Khar West", "2026-08-11T02:00:00+00:00"),
        _listing(3, "JVM Aroma", "Thane West", "2026-08-11T01:00:00+00:00"),
    ]

    response = storage.get_shared_market_listings(limit=100)

    assert [row["building_name"] for row in response["results"]] == [
        "Kabra Paradise",
        "Rustomjee Paramount",
        "JVM Aroma",
    ]
    assert len({row["latitude"] for row in response["results"]}) == 3
