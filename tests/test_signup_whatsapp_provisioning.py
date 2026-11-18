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


def _profile_storage(existing_rows, calls):
    import httpx

    def handler(request):
        q = dict(request.url.params)
        calls.append((request.method, request.url.path, q, request.content.decode() or None))
        if request.method == "POST":
            return httpx.Response(409, json={"code": "23505", "message": "duplicate key value violates unique constraint"})
        if request.method == "PATCH":
            return httpx.Response(200, json=[{"id": 5, "city": "Mumbai"}])
        rows = existing_rows
        if "tenant_id" in q:
            rows = [r for r in rows if r.get("tenant_id") == q["tenant_id"].split(".", 1)[1]]
        if "auth_user_id" in q:
            rows = [r for r in rows if r.get("auth_user_id") == q["auth_user_id"].split(".", 1)[1]]
        if "phone" in q:
            rows = [r for r in rows if r.get("phone") == q["phone"].split(".", 1)[1]]
        return httpx.Response(200, json=rows)

    return _real_storage(handler)


def _patches(calls):
    import json
    return [(c[2], json.loads(c[3])) for c in calls if c[0] == "PATCH"]


def test_phone_only_row_in_other_tenant_is_never_claimed_or_written():
    calls = []
    st = _profile_storage([{"id": 5, "phone": "9820056180", "auth_user_id": None, "tenant_id": "legacy"}], calls)
    st._tenant_id = "t1"
    with pytest.raises(Exception):
        st.save_user_profile("919820056180", {"first_name": "V", "city": "Mumbai"}, auth_user_id="u1", tenant_id="t1")
    assert _patches(calls) == [], "no write may reach the unowned cross-tenant row"
    assert not any(b'"auth_user_id"' in (c[3] or "").encode() and c[0] == "PATCH" for c in calls)


def test_own_row_under_other_tenant_updated_by_auth_user_id_without_rebinding():
    import json
    calls = []
    st = _profile_storage([{"id": 5, "phone": "9820056180", "auth_user_id": "u1", "tenant_id": "legacy"}], calls)
    st._tenant_id = "t1"
    st.save_user_profile("919820056180", {"first_name": "V", "city": "Mumbai"}, auth_user_id="u1", tenant_id="t1")
    assert not [c for c in calls if c[0] == "POST"]
    (params, body), = _patches(calls)
    assert params.get("auth_user_id") == "eq.u1"
    assert body["tenant_id"] == "legacy" and body["auth_user_id"] == "u1"
    assert body["phone"] == "9820056180"


def test_conflict_recovery_only_writes_row_owned_by_this_auth_user_and_only_descriptive_fields():
    calls = []
    st = _profile_storage([{"id": 5, "phone": "9820056180", "auth_user_id": "u1", "tenant_id": "old"}], calls)
    payload = {"phone": "9820056180", "first_name": "V", "last_name": "", "city": "Mumbai", "email": "x@y", "updated_at": "now", "auth_user_id": "u1", "tenant_id": "t1"}
    assert st._update_profile_after_insert_conflict(payload, "u1").data[0]["city"] == "Mumbai"
    (params, body), = _patches(calls)
    assert params == {"id": "eq.5", "auth_user_id": "eq.u1"}
    assert set(body) == {"first_name", "last_name", "city", "updated_at"}


def test_conflict_recovery_never_writes_unowned_phone_row():
    calls = []
    st = _profile_storage([{"id": 5, "phone": "9820056180", "auth_user_id": None, "tenant_id": "old"}], calls)
    payload = {"phone": "9820056180", "first_name": "V", "city": "Mumbai", "auth_user_id": "u1"}
    assert st._update_profile_after_insert_conflict(payload, "u1") is None
    assert _patches(calls) == []


def test_conflict_recovery_never_writes_to_row_owned_by_other_user():
    calls = []
    st = _profile_storage([{"id": 5, "phone": "9820056180", "auth_user_id": "someone-else"}], calls)
    payload = {"phone": "9820056180", "first_name": "V", "city": "Mumbai", "auth_user_id": "u1"}
    assert st._update_profile_after_insert_conflict(payload, "u1") is None
    assert _patches(calls) == []



def test_get_profile_reads_own_row_saved_under_other_tenant_but_not_phone_only_rows():
    calls = []
    st = _profile_storage([{"id": 5, "phone": "9820056180", "auth_user_id": "u1", "tenant_id": "legacy"}], calls)
    st._tenant_id = "t1"
    assert st.get_user_profile(auth_user_id="u1", tenant_id="t1")["id"] == 5
    calls2 = []
    st2 = _profile_storage([{"id": 6, "phone": "9820056180", "auth_user_id": None, "tenant_id": "legacy"}], calls2)
    st2._tenant_id = "t1"
    assert st2.get_user_profile(phone="919820056180", auth_user_id="u1", tenant_id="t1") is None
