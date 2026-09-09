from preflight_classifier import classify_document_type, classify_message, classify_source_block


def test_preflight_classifier_returns_shared_structural_contract():
    source = """3 BHK FLATS RENTAL ANDHERI WEST
1) Royal Classic
3 BHK
Rent: ₹1.55 Lakh
2) Another Building
4 BHK
Rent: ₹2.20 Lakh"""

    result = classify_message(source)

    assert result.document_type == "Multi Listing"
    assert result.pattern_id == "numbered"
    assert result.block_count == 2
    assert "numbered_items" in result.signals
    assert "rent_cue" in result.signals
    assert classify_document_type(source) == "Multi Listing"


def test_preflight_classifier_preserves_discussion_and_requirement_types():
    assert classify_document_type("Hi, thanks for your message") == "Discussion"
    assert classify_document_type("Requirement: looking for 2 BHK in Bandra") == "Requirement"


def test_preflight_reports_field_cues_for_compact_broker_shorthand():
    result = classify_message(
        "Apeksha\n1+1 BHK Jodi Unit\n1000 SQFT BU Area\nHigher Floor\n2 Car Parks\nSale Price ₹3.70 Cr"
    )

    assert {
        "built_up_area_cue",
        "parking_cue",
        "floor_cue",
        "combination_unit_cue",
    }.issubset(result.signals)


def test_source_block_preflight_is_item_scoped_even_without_splitter_chunks():
    result = classify_source_block(
        "SHOWROOM AVAILABLE ON RENT\nLocation: New link road, Andheri (West)\n"
        "Area: 2192sqft carpet\n6 Car parkings\nMonthly Compensation Rs. 8 Lakhs"
    )
    assert result.document_type == "Single Listing"
    assert result.block_count == 1
    assert "rent_cue" in result.signals
    assert "commercial_cue" in result.signals


def test_source_block_preflight_does_not_split_internal_dash_lines():
    result = classify_source_block(
        "* CHAITANYA – PRABHADEVI*\n5 BHK Exclusive Penthouse\n"
        "2,800 Sq. Ft. Carpet\n450 Sq. Ft. Terrace\n₹5 Lakhs / Month"
    )
    assert result.document_type == "Single Listing"
    assert result.block_count == 1
