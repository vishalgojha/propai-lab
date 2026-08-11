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
