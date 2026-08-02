import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from routers import onboarding


def test_onboarding_groups_falls_back_on_internal_failure(monkeypatch):
    monkeypatch.setattr(onboarding, "_resolve_active_organization_id", lambda user, tenant_id: "org-1")
    monkeypatch.setattr(onboarding, "_require_org_permission", lambda *args, **kwargs: None)
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
