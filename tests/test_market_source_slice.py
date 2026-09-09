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
    assert result.index("*Raheja bay*") > result.index("*4BHK FOR RENT*")
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

    assert result.startswith("*4BHK FOR RENT*")
    assert "Golden peak" not in result


def test_heading_only_slice_uses_single_bhk_from_complete_raw_message():
    result = _source_evidence_for_typed_row(
        {"building_name": "Palm Crest Apt", "bhk": None},
        {"message": "Available 2bhk On Lease\nPalm Crest Apt\nFully furnished\nRent 1.35 lakh"},
        "Available 2bhk On Lease",
    )

    assert "Palm Crest Apt" in result
    assert "1.35 lakh" in result
