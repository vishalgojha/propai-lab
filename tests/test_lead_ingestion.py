from services.lead_ingestion import normalize_lead


def test_normalize_meta_field_data_into_private_requirement():
    result = normalize_lead("meta", {
        "leadgen_id": "meta-123",
        "field_data": [
            {"name": "full_name", "values": ["Raj Mehta"]},
            {"name": "phone_number", "values": ["+919876543210"]},
            {"name": "preferred_location", "values": ["Bandra West"]},
            {"name": "bhk", "values": ["3 BHK"]},
            {"name": "budget", "values": ["6 Cr"]},
            {"name": "purpose", "values": ["Buy"]},
        ],
    })
    assert result["idempotency_key"] == "meta-123"
    assert result["contact_name"] == "Raj Mehta"
    assert result["contact_phone"] == "+919876543210"
    assert result["parsed_requirement"]["req_type"] == "residential_sale"
    assert result["parsed_requirement"]["micro_market"] == "Bandra West"
    assert result["parsed_requirement"]["bhk_options"] == [3]
    assert result["parsed_requirement"]["budget_max"] == 60_000_000


def test_normalize_is_idempotent_without_provider_id():
    payload = {"name": "A", "message": "2 BHK rent in Bandra", "locality": "Bandra"}
    first = normalize_lead("99acres", payload)
    second = normalize_lead("99acres", payload)
    assert first["idempotency_key"] == second["idempotency_key"]
