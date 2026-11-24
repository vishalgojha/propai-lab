import asyncio
from types import SimpleNamespace

from routers import phone_directory as directory


def test_directory_add_request_accepts_blank_optional_label():
    request = directory.DirectoryAddRequest(
        phone_number="+919820056180",
        display_label=None,
    )

    assert request.display_label is None


def test_list_directory_returns_frontend_count_contract(monkeypatch):
    async def allow(*_args, **_kwargs):
        return None

    monkeypatch.setattr(directory, "_require_org_permission", allow)
    monkeypatch.setattr(directory, "_request_organization_id", allow)
    monkeypatch.setattr(
        directory,
        "storage",
        SimpleNamespace(
            list_org_whatsapp_phone_directory=lambda _org_id: [
                {
                    "id": "entry-1",
                    "broker_id": "broker-1",
                    "phone_number": "919820056180",
                    "display_label": "",
                    "is_active": True,
                }
            ],
            is_super_admin=lambda _user_id: False,
        ),
    )

    result = asyncio.run(
        directory.list_directory(
            "org-1",
            user={"id": "user-1"},
            tenant_id="org-1",
        )
    )

    assert result["cap"] == 3
    assert result["used"] == 1
    assert result["entries"][0]["phone_number"] == "919820056180"


def _run_delete(monkeypatch, delete_session):
    from fastapi import HTTPException

    async def allow(*_a, **_k):
        return "org-1"

    async def scoped(*_a, **_k):
        return {"broker_id": "broker-1"}

    removed, calls = [], []

    async def ingestor(verb, path, **kw):
        calls.append((path, kw.get("timeout")))
        if path == "/delete-session":
            return delete_session()
        return "http://i", SimpleNamespace(status_code=200)

    monkeypatch.setattr(directory, "_require_org_permission", allow)
    monkeypatch.setattr(directory, "_request_organization_id", allow)
    monkeypatch.setattr(directory, "_scoped_directory_entry", scoped)
    monkeypatch.setattr(directory, "_first_ingestor_response", ingestor)
    monkeypatch.setattr(
        directory,
        "storage",
        SimpleNamespace(
            is_super_admin=lambda _u: False,
            get_org_whatsapp_connection_by_broker_id=lambda _b: {"id": 5},
            remove_org_whatsapp_connection=lambda i: removed.append(("conn", i)),
            remove_org_whatsapp_phone_directory=lambda i: removed.append(("dir", i)) or True,
        ),
    )
    try:
        result = asyncio.run(directory.delete_directory_entry("org-1", "e1", {"id": "u"}, None))
        return result, None, removed, calls
    except HTTPException as err:
        return None, err.status_code, removed, calls


def test_delete_directory_entry_fails_closed_on_every_unconfirmed_stop(monkeypatch):
    import httpx

    def boom():
        raise httpx.ReadTimeout("slow")

    cases = {
        "409": (lambda: ("http://i", SimpleNamespace(status_code=409)), 409),
        "5xx": (lambda: ("http://i", SimpleNamespace(status_code=500)), 502),
        "ambiguous": (lambda: ("http://i", None), 502),
        "unreachable": (lambda: (None, None), 502),
        "timeout": (boom, 502),
    }
    for name, (fn, expected) in cases.items():
        result, status, removed, calls = _run_delete(monkeypatch, fn)
        assert result is None and status == expected, name
        assert removed == [], name
        assert [c[0] for c in calls] == ["/disconnect", "/delete-session"], name
        assert dict(calls)["/delete-session"] >= 30, name


def test_delete_directory_entry_removes_rows_only_after_confirmed_stop(monkeypatch):
    result, status, removed, calls = _run_delete(
        monkeypatch, lambda: ("http://i", SimpleNamespace(status_code=200))
    )
    assert status is None and result == {"ok": True, "id": "e1"}
    assert removed == [("conn", 5), ("dir", "e1")]
    assert [c[0] for c in calls] == ["/disconnect", "/delete-session"]
