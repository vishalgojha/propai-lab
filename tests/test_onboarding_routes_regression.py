import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routers import whatsapp_group_controls as onboarding


def test_onboarding_groups_falls_back_on_internal_failure(monkeypatch):
    monkeypatch.setattr(onboarding, "_resolve_active_organization_id", lambda user, tenant_id: "org-1")
    async def allow_permission(*args, **kwargs):
        return None

    monkeypatch.setattr(onboarding, "_require_org_permission", allow_permission)
    monkeypatch.setattr(onboarding, "_connection", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")))
    monkeypatch.setattr(onboarding, "_group_directory", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not run")))
    monkeypatch.setattr(onboarding, "_cap_state", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not run")))

    result = asyncio.run(onboarding.onboarding_groups(whatsapp_connection_id=1, user={"id": "u1"}, tenant_id="org-1"))

    assert result["groups"] == []
    assert result["tier"] == "unknown"
    assert result["cap"] is None
    assert result["unlimited"] is True
    assert result["opted_out_count"] == 0


def test_group_cap_falls_back_on_internal_failure(monkeypatch):
    monkeypatch.setattr(onboarding, "_resolve_active_organization_id", lambda user, tenant_id: "org-1")
    monkeypatch.setattr(onboarding, "_require_org_permission", lambda *args, **kwargs: None)
    monkeypatch.setattr(onboarding, "_connection", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("boom")))
    monkeypatch.setattr(onboarding, "_cap_state", lambda *args, **kwargs: (_ for _ in ()).throw(AssertionError("should not run")))

    result = asyncio.run(onboarding.group_cap(whatsapp_connection_id=1, user={"id": "u1"}, tenant_id="org-1"))

    assert result["tier"] == "unknown"
    assert result["cap"] is None
    assert result["unlimited"] is True
    assert result["remaining"] is None


def test_onboarding_groups_loads_directory_without_overlap_work(monkeypatch):
    calls = {}
    monkeypatch.setattr(onboarding, "_resolve_active_organization_id", lambda user, tenant_id: "org-1")
    async def allow_permission(*args, **kwargs):
        return None

    monkeypatch.setattr(onboarding, "_require_org_permission", allow_permission)
    monkeypatch.setattr(onboarding, "_connection", lambda *args, **kwargs: {"broker_id": 42})

    def fake_directory(*args, **kwargs):
        calls["directory"] = kwargs
        return [{"group_jid": "1@g.us"}]

    monkeypatch.setattr(
        onboarding,
        "_group_directory",
        fake_directory,
    )
    monkeypatch.setattr(
        onboarding,
        "_cap_state",
        lambda *args, **kwargs: {"tier": "pro", "cap": None, "unlimited": True},
    )

    result = asyncio.run(onboarding.onboarding_groups(whatsapp_connection_id=33, user={"id": "u1"}, tenant_id="org-1"))

    assert result["groups"] == [{"group_jid": "1@g.us"}]
    assert calls["directory"]["include_overlap"] is False
    assert result["unlimited"] is True


def test_opt_out_persists_when_directory_refresh_is_unavailable(monkeypatch):
    class Result:
        data = [{"group_jid": "123@g.us", "opted_out": True}]

    class Table:
        def upsert(self, *args, **kwargs):
            return self

        def execute(self):
            return Result()

    class Client:
        def table(self, name):
            assert name == "organization_group_connections"
            return Table()

    monkeypatch.setattr(onboarding, "_resolve_active_organization_id", lambda user, tenant_id: "org-1")
    async def allow_permission(*args, **kwargs):
        return None

    monkeypatch.setattr(onboarding, "_require_org_permission", allow_permission)
    monkeypatch.setattr(onboarding, "_connection", lambda *args, **kwargs: {"broker_id": 42})
    monkeypatch.setattr(onboarding, "_group_directory", lambda *args, **kwargs: [])
    monkeypatch.setattr(onboarding, "_overlap", lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("directory down")))
    monkeypatch.setattr(onboarding, "_set_group_extraction_suppressed", lambda *args, **kwargs: None)
    monkeypatch.setattr(onboarding, "_cap_state", lambda *args, **kwargs: {"unlimited": True})
    monkeypatch.setattr(onboarding.storage, "_real", type("FakeStorage", (), {"client": Client()})())

    result = asyncio.run(onboarding.opt_out_group(
        onboarding.GroupRequest(
            whatsapp_connection_id=33,
            group_jid="123@g.us",
            group_name="Family group",
        ),
        user={"id": "u1"},
        tenant_id="org-1",
    ))

    assert result["ok"] is True
    assert result["group"]["group_name"] == "Family group"
    assert result["opted_out"] is True
