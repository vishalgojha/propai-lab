import pytest
from routers import common


class FakeStorage:
    def __init__(self):
        self.connections = []
        self.directory = []

    def list_org_whatsapp_connections(self, _org_id):
        return list(self.connections)

    def list_org_whatsapp_phone_directory(self, _org_id):
        return list(self.directory)

    def add_org_whatsapp_connection(self, org_id, phone_number, instance_name, broker_id):
        row = {
            "organization_id": org_id,
            "phone_number": phone_number,
            "instance_name": instance_name,
            "broker_id": broker_id,
        }
        self.connections.append(row)
        return row

    def add_unpaired_org_whatsapp_connection_once(self, org_id, broker_id):
        # Mirrors the DB function: return the existing placeholder if any.
        for row in self.connections:
            if str(row["phone_number"]).startswith("Unpaired:"):
                return row
        return self.add_org_whatsapp_connection(org_id, f"Unpaired:{broker_id}", "", broker_id)

    def add_org_whatsapp_phone_directory(self, org_id, broker_id, phone_number, label, active):
        self.directory.append({
            "organization_id": org_id,
            "broker_id": broker_id,
            "phone_number": phone_number,
            "display_label": label,
            "is_active": active,
        })


def test_signup_without_phone_still_gets_qr_pairing_placeholder(monkeypatch):
    storage = FakeStorage()
    monkeypatch.setattr(common, "storage", storage)

    common._ensure_signup_whatsapp_phone({"user_metadata": {}}, "org-1")

    assert len(storage.connections) == 1
    assert storage.connections[0]["phone_number"].startswith("Unpaired:phone-")
    assert storage.directory == []

    common._ensure_signup_whatsapp_phone({"user_metadata": {}}, "org-1")
    assert len(storage.connections) == 1


def test_signup_phone_still_registers_real_number_and_directory(monkeypatch):
    storage = FakeStorage()
    monkeypatch.setattr(common, "storage", storage)

    common._ensure_signup_whatsapp_phone(
        {"user_metadata": {"phone": "09876543210"}}, "org-1"
    )

    assert storage.connections[0]["phone_number"] == "919876543210"
    assert storage.directory[0]["phone_number"] == "919876543210"


def test_concurrent_signup_provisioning_creates_one_placeholder(monkeypatch):
    import threading
    import time

    storage = FakeStorage()
    orig_list = storage.list_org_whatsapp_connections

    def slow_list(org_id):
        rows = orig_list(org_id)
        time.sleep(0.05)  # widen the check-then-insert window
        return rows

    storage.list_org_whatsapp_connections = slow_list
    monkeypatch.setattr(common, "storage", storage)

    threads = [
        threading.Thread(target=common._ensure_signup_whatsapp_phone, args=({"user_metadata": {}}, "org-race"))
        for _ in range(4)
    ]
    [t.start() for t in threads]
    [t.join() for t in threads]

    assert len(storage.connections) == 1


def _real_storage(handler):
    import httpx
    from storage.supabase import SupabaseStorage, _RestClient

    client = _RestClient("https://example.supabase.co", "k")
    client._http = httpx.Client(transport=httpx.MockTransport(handler))
    storage = object.__new__(SupabaseStorage)
    storage._client = client
    return storage


def test_unpaired_once_uses_function_result():
    import httpx

    def handler(request):
        assert request.url.path.endswith("/rpc/add_unpaired_whatsapp_connection_once")
        return httpx.Response(200, json=[{"id": 7, "phone_number": "Unpaired:b1"}])

    assert _real_storage(handler).add_unpaired_org_whatsapp_connection_once("o1", "b1")["id"] == 7


def test_unpaired_once_falls_back_only_when_function_missing():
    import httpx

    def handler(request):
        return httpx.Response(404, json={"code": "PGRST202", "message": "Could not find the function public.add_unpaired_whatsapp_connection_once(p_broker_id, p_org) in the schema cache"})

    storage = _real_storage(handler)
    inserted = []
    storage.get_org_placeholder_whatsapp_connection = lambda org: inserted[0] if inserted else None
    storage.add_org_whatsapp_connection = lambda org, phone, inst="", broker="": (inserted.append({"id": 1, "phone_number": phone}) or inserted[0])
    first = storage.add_unpaired_org_whatsapp_connection_once("o1", "b1")
    second = storage.add_unpaired_org_whatsapp_connection_once("o1", "b1")
    assert first["phone_number"] == "Unpaired:b1" and second is first and len(inserted) == 1


@pytest.mark.parametrize("status,body", [
    (403, {"code": "42501", "message": "permission denied for function add_unpaired_whatsapp_connection_once"}),
    (404, {"code": "PGRST202", "message": "Could not find the function public.some_other_function"}),
    (500, {"code": "XX000", "message": "add_unpaired_whatsapp_connection_once runtime failure"}),
])
def test_unpaired_once_other_errors_propagate(status, body):
    import httpx

    storage = _real_storage(lambda request: httpx.Response(status, json=body))
    storage.add_org_whatsapp_connection = lambda *a, **k: pytest.fail("must not insert on non-missing errors")
    storage.get_org_placeholder_whatsapp_connection = lambda org: None
    with pytest.raises(RuntimeError):
        storage.add_unpaired_org_whatsapp_connection_once("o1", "b1")
