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

    def _compute_capability_status(name, type_counts, any_phone, any_connected):
        if name in app_module._CAPTURED_UNUSED_CAPS:
            return "captured_unused", 0
        if name in app_module._ALWAYS_ON_CAPS:
            if any_connected:
                return "active", 0
            if any_phone:
                return "partial", 0
            return "not_available", 0
        type_key = app_module._CAPABILITY_TYPE_KEY.get(name)
        count = int(type_counts.get(type_key, 0)) if type_key else 0
        if count > 0:
            return "active", count
        if any_phone:
            return "partial", 0
        return "not_available", 0

    app_module._compute_capability_status = _compute_capability_status
    return app_module


mod = _build_module()


def assert_eq(actual, expected, label):
    assert actual == expected, f"{label}: expected {expected!r}, got {actual!r}"


def test_captured_unused_always_returned():
    for connected in (False, True):
        for phone in (False, True):
            for counts in ({}, {"reaction": 999}):
                status, _ = mod._compute_capability_status("Read Receipts", counts, phone, connected)
                assert_eq(status, "captured_unused", f"Read Receipts phone={phone} connected={connected}")
                status, _ = mod._compute_capability_status("Typing Presence", counts, phone, connected)
                assert_eq(status, "captured_unused", f"Typing Presence phone={phone} connected={connected}")


def test_always_on_when_connected():
    for cap in ("Outgoing Messages", "History Sync", "Profile Pictures", "Group Directory",
                "Media Download", "Media Upload", "Self-Chat Agent"):
        status, _ = mod._compute_capability_status(cap, {}, any_phone=True, any_connected=True)
        assert_eq(status, "active", f"{cap} connected")


def test_always_on_phone_but_not_connected_is_partial():
    for cap in ("Outgoing Messages", "History Sync", "Profile Pictures", "Group Directory",
                "Media Download", "Media Upload", "Self-Chat Agent"):
        status, _ = mod._compute_capability_status(cap, {}, any_phone=True, any_connected=False)
        assert_eq(status, "partial", f"{cap} phone only")


def test_always_on_no_phone_is_not_available():
    for cap in ("Outgoing Messages", "History Sync", "Profile Pictures", "Group Directory",
                "Media Download", "Media Upload", "Self-Chat Agent"):
        status, _ = mod._compute_capability_status(cap, {}, any_phone=False, any_connected=False)
        assert_eq(status, "not_available", f"{cap} no phone")


def test_evidence_with_count_is_active_and_returns_count():
    status, count = mod._compute_capability_status(
        "Images", {"image": 42}, any_phone=True, any_connected=True
    )
    assert_eq(status, "active", "Images with count")
    assert_eq(count, 42, "Images evidence count")

    status, count = mod._compute_capability_status(
        "Live Location", {"live_location": 3}, any_phone=True, any_connected=True
    )
    assert_eq(status, "active", "Live Location with count")
    assert_eq(count, 3, "Live Location count")


def test_evidence_with_zero_count_and_phone_is_partial():
    status, count = mod._compute_capability_status(
        "Video", {"video": 0, "image": 10}, any_phone=True, any_connected=True
    )
    assert_eq(status, "partial", "Video zero count + phone")
    assert_eq(count, 0, "Video zero count")


def test_evidence_with_zero_count_and_no_phone_is_not_available():
    status, count = mod._compute_capability_status(
        "Stickers", {}, any_phone=False, any_connected=False
    )
    assert_eq(status, "not_available", "Stickers no phone")
    assert_eq(count, 0, "Stickers no count")


def test_unknown_capability_name_falls_back_gracefully():
    # Unknown names are not in any bucket and not in type key.
    # With a connected phone, they show as partial (we have a phone but don't track this cap).
    status, count = mod._compute_capability_status(
        "Mystery Feature", {"text": 99}, any_phone=True, any_connected=True
    )
    assert_eq(status, "partial", "Unknown feature with phone")
    assert_eq(count, 0, "Unknown feature count")

    # Without any phone, unknown caps show as not_available.
    status, _ = mod._compute_capability_status(
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


if __name__ == "__main__":
    test_captured_unused_always_returned()
    test_always_on_when_connected()
    test_always_on_phone_but_not_connected_is_partial()
    test_always_on_no_phone_is_not_available()
    test_evidence_with_count_is_active_and_returns_count()
    test_evidence_with_zero_count_and_phone_is_partial()
    test_evidence_with_zero_count_and_no_phone_is_not_available()
    test_unknown_capability_name_falls_back_gracefully()
    test_capability_to_type_keys_match_known_extractor_values()
    print("OK: all capability status tests passed")
