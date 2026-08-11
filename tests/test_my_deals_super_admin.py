import asyncio
from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from routers import listings
from storage.supabase import SupabaseStorage


def test_super_admin_my_deals_does_not_require_duplicate_team_member(monkeypatch):
    async def missing_member(**_kwargs):
        raise HTTPException(403, "No active team member is linked to this account")

    calls = []
    fake_storage = SimpleNamespace(
        is_super_admin=lambda _user_id: True,
        get_my_deals=lambda limit, tenant_id, team_member_id: calls.append(
            (limit, tenant_id, team_member_id)
        ) or [{"id": 1}],
    )
    monkeypatch.setattr(listings, "get_current_team_member", missing_member)
    monkeypatch.setattr(listings, "storage", fake_storage)

    result = asyncio.run(
        listings.get_my_deals(
            limit=25,
            user={"id": "platform-admin"},
            tenant_id="selected-workspace",
        )
    )

    assert result == [{"id": 1}]
    assert calls == [(25, "selected-workspace", None)]


def test_non_admin_my_deals_preserves_team_member_http_error(monkeypatch):
    async def missing_member(**_kwargs):
        raise HTTPException(403, "No active team member is linked to this account")

    monkeypatch.setattr(listings, "get_current_team_member", missing_member)
    monkeypatch.setattr(
        listings,
        "storage",
        SimpleNamespace(is_super_admin=lambda _user_id: False),
    )

    with pytest.raises(HTTPException) as exc_info:
        asyncio.run(
            listings.get_my_deals(
                user={"id": "regular-user"},
                tenant_id="selected-workspace",
            )
        )

    assert exc_info.value.status_code == 403
    assert exc_info.value.detail == "No active team member is linked to this account"


class _Query:
    def __init__(self, rows):
        self.rows = rows

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def in_(self, *_args, **_kwargs):
        return self

    def execute(self):
        return SimpleNamespace(data=self.rows)


def test_admin_scope_without_team_member_includes_selected_workspace_connections():
    storage = object.__new__(SupabaseStorage)
    storage.list_org_whatsapp_connections = lambda _tenant_id: [
        {"id": 11, "is_active": True, "phone_number": "919111111111"},
        {"id": 12, "is_active": True, "phone_number": "919222222222"},
    ]
    storage._client = SimpleNamespace(
        table=lambda table: _Query(
            [{"group_jid": "group-a@g.us"}, {"group_jid": "group-b@g.us"}]
            if table == "organization_group_connections"
            else []
        )
    )

    groups = storage._team_member_group_scope("selected-workspace", None)

    assert groups == {"group-a@g.us", "group-b@g.us"}
