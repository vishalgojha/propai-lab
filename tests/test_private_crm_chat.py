from agent_tools import execute_tool, _pending


class _FakeTable:
    def __init__(self):
        self.payload = None

    def insert(self, payload):
        self.payload = payload
        return self

    def execute(self):
        return type("Result", (), {"data": [{"id": 42, **self.payload}]})()


class _FakeClient:
    def __init__(self):
        self.tables = {}

    def table(self, name):
        self.tables.setdefault(name, _FakeTable())
        return self.tables[name]


def test_private_crm_save_requires_confirmation_and_has_private_copy(monkeypatch):
    monkeypatch.setenv("PROPAI_AGENT_CONFIRMATION_SECRET", "test-confirmation-secret")
    pending = _pending("save_private_inventory", {"source_text": "2 BHK at Bandra West"}, "tenant-1", "user-1")
    assert pending["status"] == "pending_confirmation"
    assert pending["title"] == "Save to Private CRM?"
    assert "not appear" in pending["message"]
    assert pending["confirmation_token"]


def test_private_crm_save_writes_only_after_confirmation(monkeypatch):
    monkeypatch.setenv("PROPAI_AGENT_CONFIRMATION_SECRET", "test-confirmation-secret")
    client = _FakeClient()
    args = {
        "source_text": "2 BHK at Bandra West for rent, 900 sq ft",
        "building_name": "Example Heights",
        "location": "Bandra West",
        "bhk": "2 BHK",
        "area_sqft": 900,
        "quote": "₹1.2 Lakh/month",
    }
    pending = execute_tool("save_private_inventory", args, client, "tenant-1", user_id="user-1")
    assert pending["status"] == "pending_confirmation"
    assert "crm_inventory" not in client.tables

    saved = execute_tool("save_private_inventory", args, client, "tenant-1", user_id="user-1", confirmed=True)
    assert saved["status"] == "ok"
    assert saved["private"] is True
    assert client.tables["crm_inventory"].payload["tenant_id"] == "tenant-1"
    assert client.tables["crm_inventory"].payload["source"] == "chat"
