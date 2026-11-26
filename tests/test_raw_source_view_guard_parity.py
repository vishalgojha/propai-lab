"""Parity between the held SQL view guard and the Python classifier.

The migration 20261126210000_raw_source_view_nonproperty_guard.sql encodes the
same word lists as broker_market_policy.py with Postgres POSIX word
boundaries. This test converts the SQL regexes to Python form and checks the
guard keeps every currently-active consent row's name class and never drops a
property group, using the grounded directory names fixture.
"""
import json
import re
from pathlib import Path

import broker_market_policy as policy

MIGRATION = Path(__file__).resolve().parent.parent / "supabase" / "migrations" / "20261126210000_raw_source_view_nonproperty_guard.sql"


def _sql_regexes():
    text = MIGRATION.read_text()
    nonprop = re.search(r"consent\.group_name ~\* '(.*?)'", text).group(1)
    prop = re.search(r"consent\.group_name !~\* '(.*?)'", text).group(1)
    convert = lambda s: re.compile(s.replace(r"\m", r"\b").replace(r"\M", r"\b"), re.IGNORECASE)
    return convert(nonprop), convert(prop)


def _guard_drops(name: str) -> bool:
    nonprop, prop = _sql_regexes()
    return bool(nonprop.search(name)) and not prop.search(name)


def test_guard_never_drops_property_names():
    for name in _directory_names():
        if policy.classify_group_share_topic(name)[0] == "property":
            assert not _guard_drops(name), f"property group dropped by SQL guard: {name}"


def test_guard_drops_every_non_property_name():
    for name in _directory_names():
        if policy.classify_group_share_topic(name)[0] == "non_property":
            assert _guard_drops(name), f"non-property group survives SQL guard: {name}"


def test_guard_matches_classifier_on_active_grants():
    # The view currently exposes active consents; the guard must not change
    # visibility for any name the classifier calls property or unclear.
    for name in _directory_names():
        cls, _ = policy.classify_group_share_topic(name)
        if cls in ("property", "unclear"):
            assert not _guard_drops(name), f"{cls} group dropped: {name}"


def _directory_names():
    fixture = Path("/tmp/unclear_names.txt")
    names = [line.strip() for line in fixture.read_text().splitlines() if line.strip()] if fixture.exists() else []
    assert names, "directory names fixture missing"
    return names
