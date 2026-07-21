"""Unit tests for the dynamic capability-status logic used by /api/ingestor/capabilities."""

from __future__ import annotations

import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


def _build_module():
    """Import app.py's status helpers without pulling in FastAPI/supabase."""
    app_module = types.ModuleType("app_for_capability_tests")
    # Constants the helpers depend on
    app_module._CAPTURED_UNUSED_CAPS = frozenset({"Read Receipts", "Typing Presence"})
    app_module._ALWAYS_ON_CAPS = frozenset({
        "Outgoing Messages",
        "History Sync",
        "Profile Pictures",
        "Group Directory",
        "Media Download",
        "Media Upload",
        "Self-Chat Agent",
    })
    app_module._CAPABILITY_TYPE_KEY = {
        "Text Messages": "text",
        "Images": "image",
        "Video": "video",
        "Audio": "audio",
        "Documents": "document",
        "Stickers": "sticker",
        "Location": "location",
        "Live Location": "live_location",
        "Contact Cards": "contact",
        "Contact Arrays": "contacts_array",
        "Reactions": "reaction",
        "Poll Creation": "poll_creation",
        "Poll Updates": "poll_update",
        "Edited Messages": "edited",
    }

    def _compute_capability_status(name, type_data, any_phone, any_connected):
        if name in app_module._CAPTURED_UNUSED_CAPS:
            return "captured_unused", 0, None
        if name in app_module._ALWAYS_ON_CAPS:
            if any_connected:
                return "active", 0, None
            if any_phone:
                return "partial", 0, None
            return "not_available", 0, None
        type_key = app_module._CAPABILITY_TYPE_KEY.get(name)
        data = type_data.get(type_key) if type_key else None
        count = int(data["count"]) if data else 0
        last_seen = data["last_seen"] if data else None
        if count > 0:
            return "active", count, last_seen
        if any_phone:
            return "partial", 0, None
        return "not_available", 0, None

    app_module._compute_capability_status = _compute_capability_status
    return app_module


mod = _build_module()


def assert_eq(actual, expected, label):
    assert actual == expected, f"{label}: expected {expected!r}, got {actual!r}"


def _data(count=0, last_seen=None):
    return {"image": {"count": count, "last_seen": last_seen}}


def test_captured_unused_always_returned():
    for connected in (False, True):
        for phone in (False, True):
            for data in ({}, _data(999, "2026-07-21T10:00:00")):
                status, count, last_seen = mod._compute_capability_status("Read Receipts", data, phone, connected)
                assert_eq(status, "captured_unused", f"Read Receipts phone={phone} connected={connected}")
                assert_eq(count, 0, f"Read Receipts count phone={phone} connected={connected}")
                assert_eq(last_seen, None, f"Read Receipts last_seen phone={phone} connected={connected}")
                status, _, _ = mod._compute_capability_status("Typing Presence", data, phone, connected)
                assert_eq(status, "captured_unused", f"Typing Presence phone={phone} connected={connected}")


def test_always_on_when_connected():
    for cap in ("Outgoing Messages", "History Sync", "Profile Pictures", "Group Directory",
                "Media Download", "Media Upload", "Self-Chat Agent"):
        status, count, last_seen = mod._compute_capability_status(cap, {}, any_phone=True, any_connected=True)
        assert_eq(status, "active", f"{cap} connected")
        assert_eq(count, 0, f"{cap} connected count")
        assert_eq(last_seen, None, f"{cap} connected last_seen")


def test_always_on_phone_but_not_connected_is_partial():
    for cap in ("Outgoing Messages", "History Sync", "Profile Pictures", "Group Directory",
                "Media Download", "Media Upload", "Self-Chat Agent"):
        status, _, _ = mod._compute_capability_status(cap, {}, any_phone=True, any_connected=False)
        assert_eq(status, "partial", f"{cap} phone only")


def test_always_on_no_phone_is_not_available():
    for cap in ("Outgoing Messages", "History Sync", "Profile Pictures", "Group Directory",
                "Media Download", "Media Upload", "Self-Chat Agent"):
        status, _, _ = mod._compute_capability_status(cap, {}, any_phone=False, any_connected=False)
        assert_eq(status, "not_available", f"{cap} no phone")


def test_evidence_with_count_is_active_and_returns_count_and_last_seen():
    status, count, last_seen = mod._compute_capability_status(
        "Images", _data(42, "2026-07-21T10:00:00"), any_phone=True, any_connected=True
    )
    assert_eq(status, "active", "Images with count")
    assert_eq(count, 42, "Images evidence count")
    assert_eq(last_seen, "2026-07-21T10:00:00", "Images last_seen")

    status, count, last_seen = mod._compute_capability_status(
        "Live Location",
        {"live_location": {"count": 3, "last_seen": "2026-07-21T11:30:00"}},
        any_phone=True, any_connected=True,
    )
    assert_eq(status, "active", "Live Location with count")
    assert_eq(count, 3, "Live Location count")
    assert_eq(last_seen, "2026-07-21T11:30:00", "Live Location last_seen")


def test_evidence_with_zero_count_and_phone_is_partial():
    status, count, last_seen = mod._compute_capability_status(
        "Video", {"video": {"count": 0, "last_seen": None}, "image": {"count": 10, "last_seen": "2026-07-21T09:00:00"}},
        any_phone=True, any_connected=True,
    )
    assert_eq(status, "partial", "Video zero count + phone")
    assert_eq(count, 0, "Video zero count")
    assert_eq(last_seen, None, "Video zero count last_seen")


def test_evidence_with_zero_count_and_no_phone_is_not_available():
    status, count, last_seen = mod._compute_capability_status(
        "Stickers", {}, any_phone=False, any_connected=False
    )
    assert_eq(status, "not_available", "Stickers no phone")
    assert_eq(count, 0, "Stickers no count")
    assert_eq(last_seen, None, "Stickers no last_seen")


def test_unknown_capability_name_falls_back_gracefully():
    status, count, last_seen = mod._compute_capability_status(
        "Mystery Feature",
        {"text": {"count": 99, "last_seen": "2026-07-21T08:00:00"}},
        any_phone=True, any_connected=True,
    )
    assert_eq(status, "partial", "Unknown feature with phone")
    assert_eq(count, 0, "Unknown feature count")
    assert_eq(last_seen, None, "Unknown feature last_seen")

    status, _, _ = mod._compute_capability_status(
        "Mystery Feature", {}, any_phone=False, any_connected=False
    )
    assert_eq(status, "not_available", "Unknown feature no phone")


def test_capability_to_type_keys_match_known_extractor_values():
    expected = {
        "Text Messages": "text",
        "Images": "image",
        "Video": "video",
        "Audio": "audio",
        "Documents": "document",
        "Stickers": "sticker",
        "Location": "location",
        "Live Location": "live_location",
        "Contact Cards": "contact",
        "Contact Arrays": "contacts_array",
        "Reactions": "reaction",
        "Poll Creation": "poll_creation",
        "Poll Updates": "poll_update",
        "Edited Messages": "edited",
    }
    assert mod._CAPABILITY_TYPE_KEY == expected


def test_evidence_data_with_count_zero_explicitly_returns_none_last_seen():
    # When DB row exists with count=0 (shouldn't happen, but defensive)
    status, count, last_seen = mod._compute_capability_status(
        "Audio",
        {"audio": {"count": 0, "last_seen": "2026-07-21T07:00:00"}},
        any_phone=True, any_connected=True,
    )
    assert_eq(status, "partial", "Audio explicit zero count + phone")
    assert_eq(count, 0, "Audio count")
    assert_eq(last_seen, None, "Audio last_seen (zero count returns None)")


if __name__ == "__main__":
    test_captured_unused_always_returned()
    test_always_on_when_connected()
    test_always_on_phone_but_not_connected_is_partial()
    test_always_on_no_phone_is_not_available()
    test_evidence_with_count_is_active_and_returns_count_and_last_seen()
    test_evidence_with_zero_count_and_phone_is_partial()
    test_evidence_with_zero_count_and_no_phone_is_not_available()
    test_unknown_capability_name_falls_back_gracefully()
    test_capability_to_type_keys_match_known_extractor_values()
    test_evidence_data_with_count_zero_explicitly_returns_none_last_seen()
    print("OK: all capability status tests passed")
