"""Per-client Supabase REST pool/timeout options for interactive paths."""

from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from storage.supabase import SupabaseStorage, _RestClient


def test_default_request_timeout_is_bulk_budget():
    client = _RestClient("https://example.supabase.co", "k")
    assert client._request_timeout == 60.0


def test_request_timeout_env_override(monkeypatch):
    monkeypatch.setenv("SUPABASE_HTTP_REQUEST_TIMEOUT_SECONDS", "22")
    client = _RestClient("https://example.supabase.co", "k")
    assert client._request_timeout == 22.0


def test_custom_request_timeout_is_used_for_table_queries():
    client = _RestClient(
        "https://example.supabase.co",
        "k",
        max_connections=8,
        max_keepalive=4,
        timeout_seconds=15,
        request_timeout=15,
    )
    assert client._request_timeout == 15.0


def test_storage_forwards_client_options():
    store = SupabaseStorage(
        "https://example.supabase.co",
        "k",
        request_timeout=15,
        max_connections=8,
    )
    assert store.client._request_timeout == 15.0
