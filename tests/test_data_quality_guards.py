from building_quality import is_valid_building_candidate, normalize_building_name
from storage.supabase import _clean_person_name, _jid_phone, _locality_fields


def test_jid_names_are_rejected_and_phone_can_be_extracted():
    assert _clean_person_name("+918424000018@s.whatsapp.net") == ""
    assert _clean_person_name(":54@s.whatsapp.net") == ""
    assert _jid_phone("+918424000018@s.whatsapp.net") == "918424000018"
    assert _jid_phone(":54@s.whatsapp.net") == ""


def test_location_object_is_promoted_to_evidence_columns():
    assert _locality_fields({
        "area": None,
        "location": {"raw_mention": "20th Road, Khar West", "resolved_locality": "Khar West"},
    }) == ("20th Road, Khar West", "Khar West")


def test_building_normalizer_preserves_real_estate_acronyms():
    assert normalize_building_name("hdil metropolis") == "HDIL Metropolis"
    assert normalize_building_name("vip plaza") == "VIP Plaza"
    assert normalize_building_name("prabhat chs") == "Prabhat CHS"
    assert normalize_building_name("81-aureate") == "81-Aureate"


def test_building_candidate_filter_rejects_broker_chatter():
    assert not is_valid_building_candidate("Thanks and Regards")
    assert not is_valid_building_candidate("plzz call")
    assert not is_valid_building_candidate("ownership")
    assert is_valid_building_candidate("HDIL Metropolis")


def test_embedded_building_phone_is_quarantined_at_both_boundaries():
    from building_quality import is_valid_building_candidate
    from extraction_quality import building_name_problem

    for value in ("Sailee 8169057382", "Sunil -9819635608", "Office – 9820404399"):
        assert building_name_problem(value) == "building_name_contains_phone"
        assert not is_valid_building_candidate(value)
