import pytest

from routers.crm import _normalize_inventory_payload, _parse_inventory_csv


def test_private_crm_csv_skips_metadata_and_preserves_human_quote():
    csv_text = """Chariot Realty Master Listings\nExported,05/08/2026\nDate,Building Name,Location,Tower,BHK,Floor,Area (sq ft),Quote,Furnishing,Amenities ,Owner Name,Availability,Pets okay ,Contact  Name ,number \n05/08/2026,Ten BKC,Bandra East,A,2,4th,772,1.60 Lacs,Semi,Lift,Owner,yes,No,Kapil,9999999999\n"""
    records, rejected = _parse_inventory_csv(csv_text)
    assert not rejected
    assert records[0]["building_name"] == "Ten BKC"
    assert records[0]["location"] == "Bandra East"
    assert records[0]["quote"] == "1.60 Lacs"
    assert records[0]["area_sqft"] == 772


def test_private_crm_csv_rejects_rows_without_identity():
    records, rejected = _parse_inventory_csv("Building Name,Location,Area (sq ft)\n,,unknown\n")
    assert records == []
    assert rejected == [{"row": 2, "error": "building_name_or_location_required"}]


def test_private_crm_manual_payload_is_normalized():
    record = _normalize_inventory_payload({
        "building_name": "  Ten BKC ",
        "location": " Bandra East ",
        "area_sqft": "1,200",
        "notes": "  internal follow-up  ",
    })
    assert record["building_name"] == "Ten BKC"
    assert record["location"] == "Bandra East"
    assert record["area_sqft"] == 1200
    assert record["notes"] == "internal follow-up"


def test_private_crm_manual_payload_requires_identity():
    with pytest.raises(ValueError, match="building_name_or_location_required"):
        _normalize_inventory_payload({"quote": "₹1L"})
