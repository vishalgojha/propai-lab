from types import SimpleNamespace

import pytest

import correction_layer as layer


def valid_payload(draft, corrected_fields=None, confidence=0.9):
    payload = dict(draft)
    payload["corrected_fields"] = corrected_fields or []
    payload["correction_confidence"] = confidence
    return payload


def test_validation_rejects_schema_drift():
    draft = {field: None for field in layer.CORRECTABLE_FIELDS}
    payload = valid_payload(draft)
    payload["invented_field"] = "unsafe"

    with pytest.raises(layer.CorrectionError, match="schema mismatch"):
        layer._validate_response(payload, draft)


def test_validation_rejects_unchanged_corrected_field():
    draft = {field: None for field in layer.CORRECTABLE_FIELDS}
    draft["building_name"] = "Sea View"
    payload = valid_payload(draft, ["building_name"])

    with pytest.raises(layer.CorrectionError, match="flagged as corrected but unchanged"):
        layer._validate_response(payload, draft)


@pytest.mark.parametrize("unit", ["Lakh", "Lakhs", "Lac", "Crore", "Cr"])
def test_validation_preserves_indian_price_unit(unit):
    draft = {field: None for field in layer.CORRECTABLE_FIELDS}
    payload = valid_payload(draft, ["price_unit"])
    payload["price_unit"] = unit

    assert layer._validate_response(payload, draft)["price_unit"] == unit


def test_write_updates_only_flagged_fields():
    calls = []

    class Query:
        def update(self, payload):
            calls.append(payload)
            return self

        def eq(self, column, value):
            calls.append((column, value))
            return self

        def execute(self):
            return SimpleNamespace(data=[{"id": 7}])

    storage = SimpleNamespace(client=SimpleNamespace(table=lambda _name: Query()))
    draft = {field: None for field in layer.CORRECTABLE_FIELDS}
    payload = valid_payload(draft, ["building_name"])
    payload["building_name"] = "Sea View"
    payload["location_raw"] = "Bandra West"

    layer._write_correction(storage, 7, "hash", payload)

    written = calls[0]
    assert written["building_name"] == "Sea View"
    assert "location_raw" not in written
    assert written["corrected_fields"] == ["building_name"]
    assert calls[1] == ("id", 7)


def test_scheduled_slot_is_two_hour_bucket():
    from datetime import datetime, timezone

    value = layer._scheduled_slot(datetime(2026, 7, 17, 5, 59, tzinfo=timezone.utc))

    assert value == "2026-07-17T04:00:00+00:00"
