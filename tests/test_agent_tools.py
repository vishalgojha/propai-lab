import agent_tools


class FakeQuery:
    def __init__(self, client, table):
        self.client = client
        self.table_name = table
        self.filters = {}
        self.insert_payload = None

    def select(self, _columns):
        return self

    def eq(self, column, value):
        self.filters[column] = value
        return self

    def or_(self, _value):
        return self

    def neq(self, column, value):
        self.filters[column] = ("neq", value)
        return self

    def is_(self, column, value):
        self.filters[column] = ("is", value)
        return self

    def limit(self, _value):
        return self

    def insert(self, payload):
        self.insert_payload = payload
        return self

    def execute(self):
        if self.insert_payload is not None:
            self.client.inserts.append((self.table_name, self.insert_payload))
            return type("Response", (), {"data": [{"id": 1, **self.insert_payload}]})()
        if self.table_name == "residential_rent_listings":
            if self.filters.get("id") == 101 and self.filters.get("tenant_id") == "tenant-1":
                return type("Response", (), {"data": [{"id": 101, "tenant_id": "tenant-1"}]})()
        if self.table_name == "clients" and self.filters.get("id") == "7":
            return type("Response", (), {"data": [{"id": 7, "name": "Client 7", "phone": "9999999999"}]})()
        return type("Response", (), {"data": []})()


class FakeClient:
    def __init__(self):
        self.inserts = []

    def table(self, name):
        return FakeQuery(self, name)


def test_agent_tool_schemas_cover_requested_tools(monkeypatch):
    names = {tool["function"]["name"] for tool in agent_tools.TOOL_DEFINITIONS}
    assert names == {
        "search_listings",
        "search_group_messages",
        "lookup_building",
        "get_client_requirements",
        "match_client_to_listings",
        "create_client_property_candidate",
        "get_broker_profile",
        "create_lead",
        "log_internal_note",
        "save_private_inventory",
        "save_my_deal",
    }
    assert agent_tools.READ_TOOL_NAMES.isdisjoint(agent_tools.WRITE_TOOL_NAMES)
    monkeypatch.setenv("PROPAI_AGENT_CONFIRMATION_SECRET", "test-secret")


def test_building_lookup_is_a_read_tool(monkeypatch):
    monkeypatch.setenv("PROPAI_AGENT_CONFIRMATION_SECRET", "test-secret")
    client = FakeClient()
    result = agent_tools.execute_tool(
        "lookup_building",
        {"query": "Rustomjee Paramount"},
        client,
        "tenant-1",
    )
    assert result["status"] == "ok"
    assert result["tool"] == "lookup_building"
    assert agent_tools.READ_TOOL_NAMES.isdisjoint(agent_tools.WRITE_TOOL_NAMES)


def test_group_message_search_is_tenant_scoped_and_returns_source_evidence():
    class RawQuery:
        def __init__(self, client):
            self.client = client
            self.filters = {}

        def select(self, _columns):
            return self

        def eq(self, column, value):
            self.filters[column] = value
            return self

        def or_(self, _value):
            return self

        def ilike(self, column, value):
            self.filters[column] = value
            return self

        def order(self, *_args, **_kwargs):
            return self

        def limit(self, _value):
            return self

        def execute(self):
            self.client.seen_filters = self.filters
            return type("Response", (), {"data": [{
                "id": 91,
                "tenant_id": "tenant-1",
                "group_name": "Bandra Brokers",
                "sender": "A Broker",
                "sender_phone": "919876543210",
                "message": "3 BHK in Bandra West for rent",
                "timestamp": "2026-09-10T08:00:00Z",
                "message_type": "text",
                "is_group": True,
            }]})()

    class RawClient:
        def table(self, name):
            assert name == "raw_messages"
            return RawQuery(self)

    client = RawClient()
    result = agent_tools.execute_tool(
        "search_group_messages",
        {"query": "what was posted about Bandra West", "limit": 5},
        client,
        "tenant-1",
    )

    assert result["status"] == "ok"
    assert result["results"][0]["message_id"] == 91
    assert result["results"][0]["source_text"] == "3 BHK in Bandra West for rent"
    assert client.seen_filters["tenant_id"] == "tenant-1"


def test_write_tools_only_queue_confirmation(monkeypatch):
    monkeypatch.setenv("PROPAI_AGENT_CONFIRMATION_SECRET", "test-secret")

    class ShouldNotQuery:
        def table(self, _name):
            raise AssertionError("write tool queried Supabase before confirmation")

    result = agent_tools.execute_tool(
        "log_internal_note",
        {"entity_type": "client", "entity_id": "c1", "note": "follow up", "author_id": "u1"},
        ShouldNotQuery(),
        "tenant-1",
        user_id="user-1",
    )

    assert result["status"] == "pending_confirmation"
    assert result["tool"] == "log_internal_note"
    assert result["confirmation_token"]


def test_confirmation_token_is_bound_to_workspace_and_user(monkeypatch):
    monkeypatch.setenv("PROPAI_AGENT_CONFIRMATION_SECRET", "test-secret")
    token = agent_tools.make_confirmation_token("create_lead", {"client_id": "c1"}, "tenant-1", "user-1")

    class NoWrite:
        def table(self, _name):
            raise AssertionError("invalid token should not reach Supabase")

    try:
        agent_tools.confirm_tool(token, NoWrite(), "tenant-2", "user-1")
    except ValueError as exc:
        assert "workspace" in str(exc)
    else:
        raise AssertionError("token from another workspace was accepted")


def test_create_lead_without_client_match_is_valid(monkeypatch):
    client = FakeClient()
    result = agent_tools.execute_tool(
        "create_lead",
        {"listing_id": 101, "source": "agent", "notes": "Call back"},
        client,
        "tenant-1",
        confirmed=True,
    )
    assert result["status"] == "ok"
    assert client.inserts[0][1]["client_id"] is None
    assert client.inserts[0][1]["tenant_id"] == "tenant-1"


def test_create_lead_with_resolved_client(monkeypatch):
    client = FakeClient()
    result = agent_tools.execute_tool(
        "create_lead",
        {"listing_id": 101, "client_id": "7", "source": "agent", "notes": "Matched client"},
        client,
        "tenant-1",
        confirmed=True,
    )
    assert result["status"] == "ok"
    assert client.inserts[0][1]["client_id"] == 7
    assert client.inserts[0][1]["client_name"] == "Client 7"


def test_write_tool_rejects_missing_tenant_context(monkeypatch):
    result = agent_tools.execute_tool(
        "create_lead",
        {"listing_id": 101, "source": "agent", "notes": "No workspace"},
        FakeClient(),
        None,
        confirmed=True,
    )
    assert result["status"] == "error"
    assert "workspace" in result["error"]
