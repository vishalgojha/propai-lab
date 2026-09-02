"""Pure formatting helpers for the private Google Drive inventory export."""

HEADERS = ["inventory_id", "building", "location", "transaction", "asset", "bhk", "area_sqft", "quote", "furnishing", "availability", "notes", "last_updated"]


def export_values(rows: list[dict]) -> list[list[str]]:
    values = [HEADERS]
    for row in rows:
        values.append([str(row.get(key) or "") for key in ("id", "building_name", "location", "transaction_type", "asset_type", "bhk", "area_sqft", "quote", "furnishing", "availability", "notes", "updated_at")])
    return values
