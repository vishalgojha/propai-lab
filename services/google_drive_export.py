"""Pure formatting helpers for the private Google Drive inventory export."""

HEADERS = ["record_type", "source_id", "title", "building", "location", "transaction", "asset", "bhk", "area_sqft", "price", "furnishing", "availability", "broker_name", "broker_phone", "description", "last_seen"]


def export_values(rows: list[dict]) -> list[list[str]]:
    values = [HEADERS]
    for row in rows:
        is_market = bool(row.get("source_schema") or row.get("_typed_table"))
        values.append([
            "market_listing" if is_market else "private_crm",
            f"{row.get('source_schema') or row.get('_typed_table') or ''}:{row.get('id') or ''}" if is_market else str(row.get("id") or ""),
            str(row.get("summary_title") or row.get("building_name") or ""), str(row.get("building_name") or ""),
            str(row.get("location") or row.get("micro_market") or row.get("location_raw") or ""),
            str(row.get("transaction_type") or ""), str(row.get("asset_type") or ""), str(row.get("bhk") or ""),
            str(row.get("area_sqft") or row.get("carpet_area_sqft") or ""),
            str(row.get("quote") or row.get("price") or row.get("total_asking_price") or row.get("monthly_rent") or ""),
            str(row.get("furnishing") or row.get("furnishing_status") or ""),
            str(row.get("availability") or row.get("availability_status") or row.get("lifecycle_status") or ""),
            str(row.get("broker_name") or ""), str(row.get("broker_phone") or ""),
            str(row.get("description") or row.get("source_notes") or row.get("source_slice_text") or ""),
            str(row.get("last_seen") or row.get("last_seen_at") or row.get("updated_at") or ""),
        ])
    return values
