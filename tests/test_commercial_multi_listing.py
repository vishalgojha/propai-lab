"""Regression test for commercial multi-listing (observation 49385).

The message contains one commercial building with four+ distinct floor/price
combinations.  Verifies the parser splits them correctly.
"""

import pytest
from multi_listing import classify_message, parse_multi_message

COMMERCIAL_FLOOR_MSG = """\
PRIME LOCATION 

THE HEART OF BANDRA WEST
TURNER ROAD 

Pillarless 

5 ***** Rating RETAIL Showroom/Flagship store
 
FOR 
ONLY LEAVE AND LICENCE 

5400 CARPET 
4550 CARPET 

Ground + one 

COST 1200 PER SQ FT + CAD 

2nd floor 
5400 Retail 
Cost 1000 per sq .ft + cad 

3 rd floor semi retail
Cost 700 per sq ft + cad 
*****
*****
For Sale and Leave and licence too . 

4th floor to 14th floor 
1000 to 5400 sq ft carpet 

For L & L 600 per sq ft + cad 

For sale 1.08k per sq ft + cad 
Car parking 

One of its kind commercial building in Bandra/Mumbai 

Profile Must . 

For leave and licence 1cr Paid Up Capital must . 

Bankim J patel
98200 78845
"""


def test_classified_as_multi():
    assert classify_message(COMMERCIAL_FLOOR_MSG) == "multi"


def test_four_or_more_listings():
    listings = parse_multi_message(COMMERCIAL_FLOOR_MSG)
    assert len(listings) >= 4, f"Expected >=4 listings, got {len(listings)}"


def test_ground_plus_one_listing():
    """Ground+one should be a separate floor block with total price."""
    listings = parse_multi_message(COMMERCIAL_FLOOR_MSG)
    ground = [l for l in listings if "Ground" in (l.get("floor_description") or "")]
    assert len(ground) >= 1, "No Ground+1 listing found"
    g = ground[0]
    assert g["floor_description"] == "Ground+1"
    assert g["price_per_sqft"] == 1200.0
    assert g["area_sqft"] == 5400.0  # inherited from header
    assert g["price"] == 64.8  # 1200 × 5400 = 64,80,000 → 64.8 Lac
    assert g["price_unit"] == "Lac"
    assert g["micro_market"] == "Bandra West"


def test_second_floor_listing():
    """2nd floor: 5400 sqft retail at ₹1000/sqft."""
    listings = parse_multi_message(COMMERCIAL_FLOOR_MSG)
    second = [l for l in listings if "2nd" in (l.get("floor_description") or "")]
    assert len(second) >= 1, "No 2nd floor listing found"
    s = second[0]
    assert s["floor_description"] == "2nd Floor"
    assert s["area_sqft"] == 5400.0
    assert s["price_per_sqft"] == 1000.0
    assert s["price"] == 54.0
    assert s["price_unit"] == "Lac"
    assert s["intent"] == "Lease"


def test_third_floor_listing():
    """3rd floor: semi-retail at ₹700/sqft (no explicit area)."""
    listings = parse_multi_message(COMMERCIAL_FLOOR_MSG)
    third = [l for l in listings if "3rd" in (l.get("floor_description") or "")]
    assert len(third) >= 1, "No 3rd floor listing found"
    t = third[0]
    assert t["floor_description"] == "3rd Floor"
    assert t["price_per_sqft"] == 700.0
    assert t["intent"] == "Lease"


def test_fourteenth_floor_lease():
    """4th-14th floor: Lease at ₹600/sqft."""
    listings = parse_multi_message(COMMERCIAL_FLOOR_MSG)
    lease = [l for l in listings if l.get("intent") == "Lease" and "14th" in (l.get("floor_description") or "")]
    assert len(lease) >= 1, "No 4th-14th Lease listing found"
    l = lease[0]
    assert l["floor_description"] == "4th-14th Floor"
    assert l["area_sqft"] == 5400.0
    assert l["price_per_sqft"] == 600.0
    assert l["price"] == 32.4
    assert l["price_unit"] == "Lac"
    assert l["intent"] == "Lease"


def test_fourteenth_floor_sale():
    """4th-14th floor: Sale at ₹1.08K/sqft = ₹1080/sqft."""
    listings = parse_multi_message(COMMERCIAL_FLOOR_MSG)
    sale = [l for l in listings if l.get("intent") == "Sale" and "14th" in (l.get("floor_description") or "")]
    assert len(sale) >= 1, "No 4th-14th Sale listing found"
    s = sale[0]
    assert s["floor_description"] == "4th-14th Floor"
    assert s["area_sqft"] == 5400.0
    assert s["price_per_sqft"] == 1080.0
    assert s["price"] == 58.32
    assert s["price_unit"] == "Lac"
    assert s["intent"] == "Sale"


def test_micro_market_in_listings():
    """All listings should carry micro_market = Bandra West."""
    listings = parse_multi_message(COMMERCIAL_FLOOR_MSG)
    for l in listings:
        assert l.get("micro_market") == "Bandra West", f"Listing missing Bandra West: {l.get('floor_description')}"


def test_no_collapsed_price():
    """No listing should have the old collapsed '1 K' style price."""
    listings = parse_multi_message(COMMERCIAL_FLOOR_MSG)
    for l in listings:
        p = l.get("price")
        u = l.get("price_unit")
        assert not (p == 1.0 and u == "K"), f"Found collapsed price in {l.get('floor_description')}"


# ═══════════════════════════════════════════════════════════════════
# Priority 2 — Ambiguous price-range shorthand (observation 49386)
# ═══════════════════════════════════════════════════════════════════

def test_ambiguous_price_shorthand_detected():
    """'2.25,/50 cr' should trigger the ambiguous-price detector."""
    from multi_listing import _detect_ambiguous_price_shorthand
    m = _detect_ambiguous_price_shorthand("Budget 2.25,/50 cr .")
    assert m is not None
    assert "2.25" in m
    assert "/50" in m
    assert "cr" in m.lower()


def test_clean_price_does_not_trigger_ambiguous_detector():
    """Clean prices like '1.5 cr' must NOT match the ambiguous detector."""
    from multi_listing import _detect_ambiguous_price_shorthand
    for clean in ("1.5 cr", "2.25 cr", "45k", "85 lac"):
        assert _detect_ambiguous_price_shorthand(clean) is None, f"False positive on {clean!r}"


def test_parse_price_from_text_resolves_ambiguous():
    """_parse_price_from_text should resolve '2.25,/50 cr' to max=2.5, unit=Cr.

    Note: This test calls the LLM normalizer and may be skipped if the
    Doubleword AI API is unavailable or flaky on first call.
    """
    from multi_listing import _parse_price_from_text, _PRICE_CACHE
    _PRICE_CACHE.clear()
    result = _parse_price_from_text("Budget 2.25,/50 cr .")
    if result[0] is None:
        pytest.skip("LLM normalizer unavailable (API cold-start or rate-limited)")
    assert result[0] == 2.5, f"Expected price=2.5, got {result[0]}"
    assert result[1] == "Cr", f"Expected unit=Cr, got {result[1]}"
