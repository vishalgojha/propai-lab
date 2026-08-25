from routers.search import (
    _corridor_endpoints,
    _corridor_from_reference_rows,
    _corridor_search_terms,
    _extract_localities,
    _price_matches_query,
    _query_prefers_requirements,
    _structured_locality_keys,
)


REFERENCE_ROWS = [
    {"sub_locality": "Bandra East", "parent_locality": "Bandra East", "sort_order": 20},
    {"sub_locality": "Bandra", "parent_locality": "Bandra", "sort_order": 25},
    {"sub_locality": "Bandra Reclamation", "parent_locality": "Bandra West", "sort_order": 30},
    {"sub_locality": "Khar East", "sort_order": 40},
    {"sub_locality": "Khar", "sort_order": 45},
    {"sub_locality": "Khar West", "sort_order": 50},
    {"sub_locality": "Santacruz East", "sort_order": 60},
    {"sub_locality": "Santacruz", "sort_order": 65},
    {"sub_locality": "Santacruz West", "sort_order": 70},
    {"sub_locality": "Vile Parle East", "sort_order": 80},
    {"sub_locality": "Vile Parle West", "sort_order": 90},
    {"sub_locality": "Juhu", "sort_order": 100},
    {"sub_locality": "Andheri East", "sort_order": 110},
    {"sub_locality": "Andheri", "sort_order": 115},
    {"sub_locality": "Andheri West", "sort_order": 120},
]


def test_between_query_extracts_multi_word_endpoints():
    query = "3 BHK rent between Bandra West and Andheri West under 3 Lakh"
    assert _corridor_endpoints(query) == ("bandra west", "andheri west")
    assert _extract_localities(query) == ["bandra west", "andheri west"]


def test_corridor_resolves_bare_parent_locality_to_known_directional_rows():
    rows = [row for row in REFERENCE_ROWS if row.get("parent_locality") != "Bandra"]
    corridor = _corridor_from_reference_rows(
        ("bandra", "andheri west"), rows
    )
    assert corridor[0] == "Bandra East"
    assert corridor[-1] == "Andheri West"


def test_corridor_uses_every_persisted_locality_between_endpoints():
    corridor = _corridor_from_reference_rows(
        ("bandra west", "andheri west"), REFERENCE_ROWS
    )
    assert corridor == [
        "Bandra West",
        "Khar East",
        "Khar",
        "Khar West",
        "Santacruz East",
        "Santacruz",
        "Santacruz West",
        "Vile Parle East",
        "Vile Parle West",
        "Juhu",
        "Andheri East",
        "Andheri",
        "Andheri West",
    ]


def test_corridor_is_direction_independent():
    assert _corridor_from_reference_rows(
        ("andheri west", "bandra west"), REFERENCE_ROWS
    ) == _corridor_from_reference_rows(
        ("bandra west", "andheri west"), REFERENCE_ROWS
    )


def test_unknown_endpoint_never_degrades_to_endpoint_or_search():
    assert _corridor_from_reference_rows(
        ("bandra west", "unknown place"), REFERENCE_ROWS
    ) == []


def test_corridor_search_terms_include_sub_locality_aliases():
    rows = [
        *REFERENCE_ROWS,
        {"sub_locality": "Pali Hill", "parent_locality": "Bandra West", "sort_order": 30},
        {"sub_locality": "Mount Mary", "parent_locality": "Bandra West", "sort_order": 30},
        {"sub_locality": "Lokhandwala", "parent_locality": "Andheri West", "sort_order": 120},
        {"sub_locality": "Hiranandani", "parent_locality": "Powai", "sort_order": 130},
    ]
    canonical = _corridor_from_reference_rows(
        ("bandra west", "andheri west"), rows
    )
    terms = _corridor_search_terms(canonical, rows)
    assert "Pali Hill" in terms
    assert "Mount Mary" in terms
    assert "Lokhandwala" in terms
    assert "Hiranandani" not in terms


def test_sale_query_prefers_listings_unless_requirements_are_explicit():
    assert not _query_prefers_requirements("apartment for sale between 10 and 15 cr")
    assert _query_prefers_requirements("buyer looking for apartment with budget 15 cr")


def test_requirement_price_filter_uses_budget_overlap_not_single_maximum():
    requirement = {"budget_min": 10_000_000, "budget_max": 15_000_000}
    assert _price_matches_query(
        requirement,
        requirement,
        is_requirement=True,
        minimum=12_000_000,
        maximum=20_000_000,
    )
    assert not _price_matches_query(
        {"budget_min": 35_000_000, "budget_max": 35_000_000},
        {"budget_min": 35_000_000, "budget_max": 35_000_000},
        is_requirement=True,
        minimum=100_000_000,
        maximum=150_000_000,
    )


def test_locality_match_never_uses_building_name_or_title():
    row = {
        "summary_title": "Apartment for sale at Andheri West Towers",
        "building_name": "Andheri West Towers",
        "micro_market": None,
        "locality_raw": None,
    }
    assert "andheri west" not in _structured_locality_keys(row)
    row["micro_market"] = "Bandra West"
    assert _structured_locality_keys(row) == {"bandra west"}
