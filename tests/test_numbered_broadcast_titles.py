"""Regression coverage for numbered rental broadcasts and safe titles."""

from extraction import (
    _ai_extraction_to_typed,
    _deterministic_named_broadcast_slices,
    _deterministic_numbered_broadcast_slices,
)
from routers.infra import generate_summary_title


SOURCE = '''*1.*"BHAGTANI ONE", Santacruz,Sf,85 k.

2.*GROTTO*, Shirley Rajan,Sf,93 k.

3.*AMIN ALTURAS*(SEAVIEW),30 Th Rd, Bandra, Furnished,1.25 Lakhs.

4.*GEORGINA*,Shirley Rajan,Sf,85 k.'''


def test_numbered_rental_broadcast_is_split_before_ai_extraction():
    pattern, chunks = _deterministic_numbered_broadcast_slices(SOURCE)

    assert pattern == "deterministic:numbered"
    assert len(chunks) == 4
    assert "GROTTO" in chunks[1]["normalized_message"]
    assert "AMIN ALTURAS" in chunks[2]["normalized_message"]


def test_mixed_requirement_broadcast_keeps_unnumbered_first_request_separate():
    source = """Requirements
Wanted Outright duplex flat in
Jeevesh Terraces
Band stand
Any floor ok
Market price
Ready buyer

2) Wanted beauty parlour space
With water connection
Bandra to Santacruz
Budget 1.65 cr

3) wanted about 150 to 200 sq feet
Office outright
With bathroom attached
Without parking ok
Bandra to Santacruz
Budget As per market"""

    pattern, chunks = _deterministic_numbered_broadcast_slices(source)

    assert pattern == "deterministic:requirement_blocks"
    assert len(chunks) == 3
    assert "duplex flat" in chunks[0]["normalized_message"]
    assert "beauty parlour" in chunks[1]["normalized_message"]
    assert "Office outright" in chunks[2]["normalized_message"]


def test_named_project_broadcast_is_split_into_exclusive_blocks():
    source = """DIRECT OUTRIGHT OPPORTUNITIES
96 TAGORE — SANTACRUZ WEST
* 4 BHK
* Carpet Area: 1,675 sq. ft.
* ₹70,000 per sq. ft. Asking
L NAGPAL — BANDRA WEST
* 3 BHK
* Area: 940 sq. ft.
* ₹70,000 per sq. ft. Asking
SILVER ROCK — BANDRA WEST
* 3 BHK
* Area: 1,258 sq. ft.
* ₹12.28 Cr
"""

    pattern, chunks = _deterministic_named_broadcast_slices(source)

    assert pattern == "deterministic:named_project"
    assert len(chunks) == 3
    assert "96 TAGORE" in chunks[0]["normalized_message"]
    assert "L NAGPAL" not in chunks[0]["normalized_message"]
    assert "SILVER ROCK" in chunks[2]["normalized_message"]


def test_residential_rental_title_is_not_generic_property_with_area():
    title = generate_summary_title(
        {
            "asset_type": "residential",
            "transaction_type": "rent",
            "building_name": "Grotto",
            "micro_market": "Bandra West",
            "monthly_rent": 93000,
            "area_sqft": None,
        },
        "*GROTTO*, Shirley Rajan, Sf, 93 k.",
    )

    assert title == "Apartment for rent in Grotto, Bandra West"
    assert "Property with" not in title
    assert "93 sqft" not in title


def test_rent_amount_is_not_reused_as_area():
    table, row = _ai_extraction_to_typed(
        {
            "listing_type": "rent",
            "property_category": "residential",
            "building_name": "Grotto",
            "locality": {"raw_mention": "Bandra West", "resolved_locality": "Bandra West"},
            "carpet_area_sqft": 93,
            "price": {"amount": 93000, "unit": "total", "raw_price_text": "93 k"},
            "title": "Property with 93 sqft for rent at Grotto, Bandra West",
        },
        "*GROTTO*, Shirley Rajan, Sf, 93 k.",
    )

    assert table == "residential_rent_listings"
    assert row.get("carpet_area_sqft") is None
    assert row["summary_title"] == "Apartment for rent in Grotto, Bandra West"
