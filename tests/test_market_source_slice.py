from storage.supabase import _relevant_market_source_slice, _source_evidence_for_typed_row


RAHEJA_BROADCAST = """*3BHK FOR RENT*

*Ladhani legacy* @ 2.80 lac /SF
New bldg untouch flat
Bandra ( off hill road )

*4BHK FOR RENT*

*Golden peak* @ 5.25lac / F
Khar West (Nr.Gymkhana)

*Steesha* @ 8lac / F
Sea view with duplex
Mount Mary

*Identity* @ 11ac / U/F
Sea view
Bandra ( Bandstand)

*Raheja bay* @ 10.5 lac & 14lac / F
Bandra ( Mount Mary )

*5BHK FOR RENT*

*Trinity* @ 12 lac / F
Khar ( Madhu park)"""


def test_named_offer_does_not_include_neighbouring_bhk_section_offers():
    result = _relevant_market_source_slice(RAHEJA_BROADCAST, "Raheja bay")

    assert "*Raheja bay*" in result
    assert "Mount Mary" in result
    assert "Golden peak" not in result
    assert "Steesha" not in result
    assert "Identity" not in result
    assert "10.5 lac & 14lac" in result


def test_typed_row_evidence_uses_named_offer_not_generic_configuration_header():
    result = _source_evidence_for_typed_row(
        {"building_name": "Raheja bay", "bhk": 4},
        {"message": RAHEJA_BROADCAST},
        "*4BHK FOR RENT*",
    )

    assert result.startswith("*Raheja bay*")
    assert "Golden peak" not in result


def test_heading_only_slice_uses_single_bhk_from_complete_raw_message():
    result = _source_evidence_for_typed_row(
        {"building_name": "Palm Crest Apt", "bhk": None},
        {"message": "Available 2bhk On Lease\nPalm Crest Apt\nFully furnished\nRent 1.35 lakh"},
        "Available 2bhk On Lease",
    )

    assert "Palm Crest Apt" in result
    assert "1.35 lakh" in result


def test_wrong_building_and_matching_bhk_line_are_not_presented_as_relevant():
    result = _source_evidence_for_typed_row(
        {"building_name": "Pioneer Heritage 3", "bhk": 2, "micro_market": "Santacruz West"},
        {
            "message": (
                "*AHUJA REALTY*\n\n*ON SALE*\n\n*AQUARIUS TOWER*\n"
                "21st rd bandra\n3BHK\nApprox 950 carpet\nQuote 5.50 cr\n"
                "\n2BHK available elsewhere"
            )
        },
        "2BHK",
    )

    assert result == ""


def test_matched_building_excerpt_keeps_the_surrounding_offer_details():
    raw = (
        "*FOR RENT*\n*Pioneer Heritage 3*\nBEST Colony, Santacruz West\n"
        "Newly done 2BHK apartment\nRent ₹75,000\nFully furnished"
    )

    result = _source_evidence_for_typed_row(
        {"building_name": "Pioneer Heritage 3", "bhk": 2},
        {"message": raw},
        "2BHK",
    )

    assert "Pioneer Heritage 3" in result
    assert "Santacruz West" in result
    assert "₹75,000" in result


def test_inline_bullet_broadcast_returns_the_complete_matching_offer():
    raw = (
        "*AHUJA REALTY* *ON SALE* • *AQUARIUS TOWER* 21st rd bandra 3BHK "
        "Approx 950 carpet Quote-@5.50 cr. Negotiable. • *KALPATARU MAGNUS* "
        "Bandra East 3BHK Higher floor Quote- @8.5 cr negotiable • *RUSTOMJEE "
        "CLEON* Bandra East 1BHK Sale @2.5 cr 2BHK Sale @4 cr *RENTAL* "
        "•*AQUARIUS TOWER* 21st Road Bandra 3Bhk 950carpet @1.70 Nego. "
        "•*BAJAJ DIAMOND* Union park 3Bhk Approx 1100 carpet Quote @1.80 "
        "per month. • *PIONEER HERITAGE 3* Daulat Nagar Santacruz West 2Bhk "
        "Newly Done Quote @ 75 per month. *CONTACT-* Rajan Ahuja"
    )

    raw_record = {"message": raw}
    result = _source_evidence_for_typed_row(
        {"building_name": "Pioneer Heritage 3", "bhk": 2},
        raw_record,
        "2BHK",
    )

    assert "PIONEER HERITAGE 3" in result
    assert "Santacruz West" in result
    assert "Newly Done" in result
    assert "75 per month" in result
    assert "AQUARIUS TOWER" not in result
    assert "KALPATARU MAGNUS" not in result
    assert "RUSTOMJEE CLEON" not in result
    assert raw[raw.index(result):raw.index(result) + len(result)] == result
    assert raw_record["message"] == raw
