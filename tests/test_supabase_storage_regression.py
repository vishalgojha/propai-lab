"""
Regression tests for Supabase bootstrap and adapter loading.

These tests cover the startup failure where Python resolved the local
`supabase/` directory instead of a client package, causing app import to crash.
"""

import asyncio

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


def test_tenant_context_rejects_another_users_tenant(monkeypatch):
    """A stale or forged browser tenant header must not cross organizations."""
    import app

    class FakeStorage:
        def get_user_organizations(self, user_id):
            assert user_id == "user-2"
            return [{"id": "org-2"}]

    monkeypatch.setattr(app, "storage", FakeStorage())
    monkeypatch.setattr(app, "_resolve_user_organization_id", lambda user: "org-2")

    tenant_id = asyncio.run(app.get_tenant_context(
        user={"id": "user-2", "email": "user2@example.com"},
        x_tenant_id="org-1",
    ))

    assert tenant_id == "org-2"


def test_tenant_context_accepts_a_users_own_tenant(monkeypatch):
    import app

    class FakeStorage:
        def get_user_organizations(self, user_id):
            return [{"id": "org-2"}, {"id": "org-3"}]

    monkeypatch.setattr(app, "storage", FakeStorage())

    tenant_id = asyncio.run(app.get_tenant_context(
        user={"id": "user-2", "email": "user2@example.com"},
        x_tenant_id="org-3",
    ))

    assert tenant_id == "org-3"


def test_market_feed_endpoints_forward_the_active_tenant(monkeypatch):
    import app

    calls = []

    class FakeStorage:
        def get_brokers_feed(self, limit, offset, min_observations, tenant_id):
            calls.append(("brokers", limit, offset, min_observations, tenant_id))
            return []

        def get_observations_feed(self, limit, offset, broker_key, intent, tenant_id):
            calls.append(("observations", limit, offset, broker_key, intent, tenant_id))
            return []

    monkeypatch.setattr(app, "storage", FakeStorage())

    asyncio.run(app.get_brokers_feed(
        user={"id": "user-2"},
        limit=25,
        offset=0,
        min_observations=1,
        tenant_id="org-2",
    ))
    asyncio.run(app.get_observations_feed(
        user={"id": "user-2"},
        limit=200,
        offset=0,
        broker_key="919999999999",
        intent="",
        phone="",
        tenant_id="org-2",
    ))

    assert calls == [
        ("brokers", 25, 0, 1, "org-2"),
        ("observations", 200, 0, "919999999999", "", "org-2"),
    ]


def test_find_broker_refreshes_stale_profile_graph(monkeypatch):
    import app

    class Result:
        def __init__(self, row):
            self.row = row

        def fetchone(self):
            return self.row

    class FakeDB:
        def __init__(self):
            self.lookups = 0

        def execute(self, query, params):
            assert "FROM brokers" in query
            assert params == ("name:sunil rajwani",)
            self.lookups += 1
            return Result(None if self.lookups == 1 else {"id": 73})

    class FakeStorage:
        def __init__(self):
            self.db = FakeDB()
            self.rebuilds = 0

        def rebuild_broker_graph(self):
            self.rebuilds += 1

    fake_storage = FakeStorage()
    monkeypatch.setattr(app, "storage", fake_storage)

    result = asyncio.run(app.find_broker(
        name="Sunil Rajwani",
        phone="",
        user={"id": "user-2"},
    ))

    assert result == {"broker_id": 73}
    assert fake_storage.rebuilds == 1
    assert fake_storage.db.lookups == 2


def test_activity_log_uses_the_authenticated_member(monkeypatch):
    import app

    captured = {}

    class FakeStorage:
        def log_activity(self, **kwargs):
            captured.update(kwargs)
            return 41

    monkeypatch.setattr(app, "storage", FakeStorage())

    result = asyncio.run(app.log_activity(
        body={
            "team_member_id": 999,
            "action": "broker_whatsapp_opened",
            "target_type": "broker",
            "target_id": "9999999999",
        },
        member={"id": 7},
    ))

    assert result == {"id": 41}
    assert captured["team_member_id"] == 7


def test_whatsapp_status_is_scoped_to_the_users_workspace():
    """A global ingestor session must not leak into another workspace."""
    import app

    status = app._select_workspace_whatsapp_status(
        [{"broker_id": "broker-owned"}],
        [
            {
                "broker_id": "broker-other",
                "connected": True,
                "phone_number": "919820056180",
            },
            {
                "broker_id": "broker-owned",
                "connected": True,
                "phone_number": "919999999774",
            },
        ],
    )

    assert status["connected"] is True
    assert status["phone_number"] == "919999999774"


def test_legacy_storage_tenant_reads_use_request_context():
    from storage.supabase import SupabaseStorage, set_tenant_id

    storage = object.__new__(SupabaseStorage)
    storage._SupabaseStorage__tenant_id_fallback = None
    try:
        set_tenant_id("org-request")
        assert storage.tenant_id == "org-request"
        assert storage._tenant_id == "org-request"

        storage.tenant_id = "org-next"
        assert storage._tenant_id == "org-next"
        assert storage._SupabaseStorage__tenant_id_fallback is None
    finally:
        set_tenant_id(None)


def test_connection_details_is_safe_without_storage(monkeypatch):
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

    assert details["connected"] is False
    assert details["connection_state"] == "unknown"
    assert details["messages_captured"] == 345


def test_connection_details_uses_whatsapp_jobs_when_status_file_is_unknown(monkeypatch):
    """Existing WhatsApp sync jobs are enough to unlock the connected workspace."""
    import app
    from types import SimpleNamespace

    class FakeStorage:
        def get_sync_jobs(self, limit=500, source="whatsapp"):
            assert source == "whatsapp"
            return [
                SimpleNamespace(finished_at="2026-07-13T09:00:00Z"),
                SimpleNamespace(finished_at="2026-07-13T09:05:00Z"),
            ]

    monkeypatch.setattr(app, "storage", FakeStorage())
    monkeypatch.setattr(app, "_status_file", lambda: {"connection_state": "unknown", "connected": False})

    details = app._connection_details()

    assert details["connected"] is False
    assert details["connection_state"] == "unknown"
    assert details["total_groups"] == 2


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
