"""
Regression tests for Supabase bootstrap and adapter loading.

These tests cover the startup failure where Python resolved the local
`supabase/` directory instead of a client package, causing app import to crash.
"""

import httpx


def test_app_imports_with_supabase_storage_available():
    """The API app should import without requiring the external supabase package."""
    import app  # noqa: F401


def test_startup_imports_match_app_dependencies():
    """The storage package exports used by app.py should stay importable."""
    from storage import (
        SupabaseStorage,
        RawMessage,
        ParsedObservation,
        ResolverDecision,
        Evaluation,
        LLMProvider,
    )

    assert SupabaseStorage is not None
    assert RawMessage is not None
    assert ParsedObservation is not None
    assert ResolverDecision is not None
    assert Evaluation is not None
    assert LLMProvider is not None

    import storage.supabase  # noqa: F401


def test_connection_details_is_safe_without_sqlite_storage(monkeypatch):
    """The WhatsApp connection endpoint should not assume storage.db exists."""
    import app
    from types import SimpleNamespace

    monkeypatch.setattr(app, "storage", SimpleNamespace())
    monkeypatch.setattr(app, "_status_file", lambda: {})
    details = app._connection_details()
    assert details["connected"] is False
    assert details["connection_state"] == "unknown"
    assert details["instance_name"] == "propai-whatsapp"


def test_connection_details_falls_back_when_status_file_is_unknown(monkeypatch):
    """A stale/missing status file should not lock a synced workspace out."""
    import app

    class Row(dict):
        def __getitem__(self, key):
            return self.get(key)

    class FakeDb:
        def execute(self, sql, params=None):
            class Result:
                def fetchone(self_inner):
                    if "COUNT(*) AS c" in sql and "group_name LIKE" in sql:
                        return Row(c=12)
                    if "COUNT(*) AS c" in sql:
                        return Row(c=345)
                    return Row(created_at="2026-07-13T09:00:00Z", timestamp="2026-07-13T09:05:00Z")

            return Result()

    class FakeStorage:
        db = FakeDb()

    monkeypatch.setattr(app, "storage", FakeStorage())
    monkeypatch.setattr(app, "_status_file", lambda: {"connection_state": "unknown", "connected": False})

    details = app._connection_details()

    assert details["connected"] is True
    assert details["connection_state"] == "open"
    assert details["messages_captured"] == 345


def test_supabase_create_client_supports_basic_query_flow():
    """The local adapter should support the query shape used by storage code."""
    from storage.supabase import create_client

    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(
            {
                "method": request.method,
                "url": str(request.url),
                "prefer": request.headers.get("prefer"),
                "body": request.content.decode(),
            }
        )
        if request.method == "GET":
            return httpx.Response(200, json=[{"id": 1, "name": "demo"}], headers={"content-range": "0-0/1"})
        if request.method == "POST":
            return httpx.Response(201, json=[{"id": 2, "name": "created"}])
        raise AssertionError(f"unexpected method: {request.method}")

    client = create_client("https://example.supabase.co", "service-key")
    client._http = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://example.supabase.co")

    result = client.table("items").select("*", count="exact").eq("name", "demo").limit(1).execute()
    assert result.data == [{"id": 1, "name": "demo"}]
    assert result.count == 1

    created = client.table("items").insert({"name": "created"}).execute()
    assert created.data == [{"id": 2, "name": "created"}]

    assert requests == [
        {
            "method": "GET",
            "url": "https://example.supabase.co/rest/v1/items?select=%2A&name=eq.demo&limit=1",
            "prefer": "count=exact",
            "body": "",
        },
        {
            "method": "POST",
            "url": "https://example.supabase.co/rest/v1/items",
            "prefer": "return=representation",
            "body": '{"name": "created"}',
        },
    ]


def test_supabase_storage_raw_message_round_trip():
    """SupabaseStorage should be able to save and fetch raw messages via REST."""
    from storage import RawMessage
    from storage.supabase import SupabaseStorage, create_client

    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = request.content.decode()
        requests.append(
            {
                "method": request.method,
                "url": str(request.url),
                "prefer": request.headers.get("prefer"),
                "body": body,
            }
        )

        if request.method == "POST" and request.url.path.endswith("/raw_messages"):
            return httpx.Response(201, json=[{"id": 7}])

        if request.method == "GET" and request.url.path.endswith("/raw_messages"):
            if "message_uid=eq.msg-123" in str(request.url):
                return httpx.Response(
                    200,
                    json=[{
                        "id": 7,
                        "message_uid": "msg-123",
                        "group_name": "Test Group",
                        "sender": "Broker",
                    }],
                )
            return httpx.Response(
                200,
                json=[{
                    "id": 7,
                    "message_uid": "msg-123",
                    "group_name": "Test Group",
                    "sender": "Broker",
                }],
                headers={"content-range": "0-0/1"},
            )

        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    client = create_client("https://example.supabase.co", "service-key")
    client._http = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://example.supabase.co")

    storage = SupabaseStorage("https://example.supabase.co", "service-key")
    storage._client = client

    message = RawMessage(
        group_name="Test Group",
        sender="Broker",
        message="Hello",
        message_uid="msg-123",
        attachments='[{"type":"image"}]',
        reply_context='{"foo":"bar"}',
        raw_payload='{"source":"whatsapp"}',
    )

    saved_id = storage.save_raw_message(message)
    assert saved_id == 7

    fetched = storage.get_raw_by_uid("msg-123")
    assert fetched is not None
    assert fetched.id == 7
    assert fetched.message_uid == "msg-123"
    assert fetched.group_name == "Test Group"

    rows = storage.get_raw_messages(limit=1)
    assert len(rows) == 1
    assert rows[0].id == 7

    assert requests[0]["method"] == "POST"
    assert requests[0]["url"] == "https://example.supabase.co/rest/v1/raw_messages"
    assert requests[0]["prefer"] == "return=representation"
    assert '"attachments": [{"type": "image"}]' in requests[0]["body"]
    assert '"reply_context": {"foo": "bar"}' in requests[0]["body"]
    assert '"raw_payload": {"source": "whatsapp"}' in requests[0]["body"]
    assert any("message_uid=eq.msg-123" in r["url"] for r in requests if r["method"] == "GET")


def test_supabase_storage_parsed_and_listing_writes():
    """SupabaseStorage should normalize parsed and listing payloads before write."""
    from lab.storage.base import Listing, ParsedObservation
    from storage.supabase import SupabaseStorage, create_client
    from lab.inventory import listing_fingerprint, listing_label

    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(
            {
                "method": request.method,
                "url": str(request.url),
                "prefer": request.headers.get("prefer"),
                "body": request.content.decode(),
            }
        )

        if request.method == "POST" and request.url.path.endswith("/parsed_output"):
            return httpx.Response(201, json=[{"id": 11}])
        if request.method == "GET" and request.url.path.endswith("/parsed_output"):
            return httpx.Response(
                200,
                json=[{
                    "id": 11,
                    "raw_message_id": 99,
                    "intent": "RENT",
                    "location": {"area": "Bandra"},
                }],
            )

        if request.method == "POST" and request.url.path.endswith("/listings"):
            return httpx.Response(201, json=[{"id": 22, "fingerprint": "fp"}])
        if request.method == "GET" and request.url.path.endswith("/listings"):
            return httpx.Response(
                200,
                json=[{
                    "id": 22,
                    "fingerprint": "fp",
                    "intent": "RENT",
                    "bhk": "2BHK",
                    "location_label": "Bandra West",
                }],
            )

        raise AssertionError(f"unexpected request: {request.method} {request.url}")

    client = create_client("https://example.supabase.co", "service-key")
    client._http = httpx.Client(transport=httpx.MockTransport(handler), base_url="https://example.supabase.co")

    storage = SupabaseStorage("https://example.supabase.co", "service-key")
    storage._client = client

    parsed = ParsedObservation(
        raw_message_id=99,
        intent="RENT",
        raw_payload='{"source":"whatsapp"}',
        location='{"area":"Bandra"}',
        embedding=b"abc",
    )
    parsed_id = storage.save_parsed(parsed)
    assert parsed_id == 11

    fetched_parsed = storage.get_parsed_by_raw(99)
    assert fetched_parsed is not None
    assert fetched_parsed.id == 11
    assert fetched_parsed.location == {"area": "Bandra"}

    listing = Listing(
        intent="RENT",
        bhk="2BHK",
        price=150000,
        price_unit="INR",
        area_sqft=1000,
        building_name="Demo Tower",
        micro_market="Bandra West",
    )
    listing_id = storage.save_listing(listing)
    assert listing_id == 22

    fetched_listing = storage.get_listing_by_fingerprint("fp")
    assert fetched_listing is not None
    assert fetched_listing.id == 22
    assert fetched_listing.fingerprint == "fp"

    assert requests[0]["method"] == "POST"
    assert requests[0]["url"] == "https://example.supabase.co/rest/v1/parsed_output"
    assert '"embedding"' not in requests[0]["body"]
    assert '"raw_payload": {"source": "whatsapp"}' in requests[0]["body"]
    assert '"location": {"area": "Bandra"}' in requests[0]["body"]

    expected_fp = listing_fingerprint({k: v for k, v in listing.__dict__.items() if v is not None})
    expected_label = listing_label({k: v for k, v in listing.__dict__.items() if v is not None})
    assert requests[1]["method"] == "GET"
    assert requests[1]["url"] == "https://example.supabase.co/rest/v1/parsed_output?select=%2A&raw_message_id=eq.99&limit=1"
    assert requests[2]["method"] == "POST"
    assert requests[2]["url"] == "https://example.supabase.co/rest/v1/listings?on_conflict=fingerprint"
    assert requests[2]["prefer"] == "resolution=merge-duplicates,return=representation"
    assert f'"fingerprint": "{expected_fp}"' in requests[2]["body"]
    assert f'"location_label": "{expected_label}"' in requests[2]["body"]
    assert requests[3]["method"] == "GET"
    assert requests[3]["url"] == "https://example.supabase.co/rest/v1/listings?select=%2A&fingerprint=eq.fp&limit=1"
