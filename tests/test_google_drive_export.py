from services.google_drive_export import export_values


def test_export_values_is_private_and_source_faithful():
    rows = [{
        "id": 7,
        "building_name": "Ten BKC",
        "location": "Bandra East",
        "transaction_type": "rent",
        "asset_type": "office",
        "bhk": "",
        "area_sqft": 310,
        "quote": "1.6 Lacs",
        "furnishing": "",
        "availability": "available",
        "notes": "Corner unit",
        "updated_at": "2026-09-02T00:00:00Z",
        "contact_number": "+919999999999",
    }]
    values = export_values(rows)
    assert values[0][0] == "inventory_id"
    assert rows[0]["contact_number"] not in values[1]
    assert values[1][1:6] == ["Ten BKC", "Bandra East", "rent", "office", ""]
