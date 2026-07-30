import asyncio

import routers.common as _common
from routers import workspace as workspace_mod


def test_workspace_members_filters_by_tenant(monkeypatch):
    seen_org = []

    class FakeStorage:
        def list_team_members(self, org_id=None):
            seen_org.append(org_id)
            return [
                {
                    "id": 1,
                    "name": "vishal",
                    "email": "vishal@chaoscraftlabs.com",
                    "role": "owner",
                    "permissions": 1023,
                    "is_active": True,
                    "organization_id": org_id,
                }
            ]

        def _perm_keys(self, _bitfield):
            return []

    monkeypatch.setattr(workspace_mod, "storage", FakeStorage())

    result = asyncio.run(
        workspace_mod.list_team_members(
            member={"id": 1, "role": "owner", "organization_id": "workspace-real"},
            tenant_id="workspace-real",
        )
    )

    assert seen_org == ["workspace-real"]
    assert result["members"][0]["organization_id"] == "workspace-real"
    assert result["members"][0]["email"] == "vishal@chaoscraftlabs.com"


def test_workspace_members_falls_back_to_request_tenant(monkeypatch):
    seen_org = []

    class FakeStorage:
        def list_team_members(self, org_id=None):
            seen_org.append(org_id)
            return []

        def _perm_keys(self, _bitfield):
            return []

    monkeypatch.setattr(workspace_mod, "storage", FakeStorage())

    asyncio.run(
        workspace_mod.list_team_members(
            member={"id": 0, "permissions": 1023, "name": "System"},
            tenant_id="workspace-real",
        )
    )

    assert seen_org == ["workspace-real"]


def test_workspace_members_member_org_takes_precedence(monkeypatch):
    seen_org = []

    class FakeStorage:
        def list_team_members(self, org_id=None):
            seen_org.append(org_id)
            return []

        def _perm_keys(self, _bitfield):
            return []

    monkeypatch.setattr(workspace_mod, "storage", FakeStorage())

    asyncio.run(
        workspace_mod.list_team_members(
            member={"id": 7, "organization_id": "member-org", "role": "admin", "permissions": 3},
            tenant_id="request-org-different",
        )
    )

    assert seen_org == ["member-org"]


def test_get_current_member_owner_fallback_scoped_to_tenant(monkeypatch):
    seen_org = []

    owner_row = {
        "id": 1,
        "name": "vishal",
        "role": "owner",
        "permissions": 1023,
        "is_active": True,
        "organization_id": "workspace-real",
    }
    other_owner = {
        "id": 2,
        "name": "kapil",
        "role": "owner",
        "permissions": 1023,
        "is_active": True,
        "organization_id": "workspace-other",
    }

    class FakeStorage:
        def list_team_members(self, org_id=None):
            seen_org.append(org_id)
            if org_id == "workspace-real":
                return [owner_row]
            if org_id == "workspace-other":
                return [other_owner]
            return [owner_row, other_owner]

        def _perm_keys(self, _bitfield):
            return []

    monkeypatch.setattr(_common, "storage", FakeStorage())

    member = asyncio.run(
        _common.get_current_member(
            x_team_member_id=None,
            tenant_id="workspace-real",
        )
    )

    assert seen_org == ["workspace-real"]
    assert member["organization_id"] == "workspace-real"
    assert member["name"] == "vishal"


def test_get_current_member_owner_fallback_empty_tenant_returns_system_object(monkeypatch):
    seen_org = []

    class FakeStorage:
        def list_team_members(self, org_id=None):
            seen_org.append(org_id)
            return []

        def _perm_keys(self, _bitfield):
            return []

    monkeypatch.setattr(_common, "storage", FakeStorage())

    member = asyncio.run(
        _common.get_current_member(x_team_member_id=None, tenant_id=None)
    )

    assert seen_org == [None]
    assert member == {"id": 0, "permissions": 1023, "name": "System"}
