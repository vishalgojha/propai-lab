import asyncio
import sys
from pathlib import Path
from types import ModuleType, SimpleNamespace
from urllib.parse import parse_qs, urlparse

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
# ai_chat_engine imports pandas for analytics helpers that these endpoint tests
# never call. Keep this focused regression runnable in the lightweight test env.
sys.modules.setdefault("pandas", ModuleType("pandas"))


def test_typed_requirement_contact_uses_source_identity_and_requirement_copy(monkeypatch):
    import routers.ai_chat as ai_chat

    calls = []

    def get_market_item_detail(item_id, source_schema, raw_message_id, tenant_id):
        calls.append((item_id, source_schema, raw_message_id, tenant_id))
        return {
            "id": item_id,
            "broker_phone": "+91 98765 43210",
            "bhk": "1.0",
            "building_name": "2 Bathrooms",
            "micro_market": "Bandra West",
            "message_type": "requirement",
            "visibility": "shared_market",
            "tenant_id": "another-workspace",
        }

    async def to_thread(func, /, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(
        ai_chat,
        "storage",
        SimpleNamespace(get_market_item_detail=get_market_item_detail),
    )
    monkeypatch.setattr(ai_chat.asyncio, "to_thread", to_thread)

    response = asyncio.run(
        ai_chat.resolve_broker_contact(
            42,
            ai_chat.BrokerContactRequest(
                source_schema="residential_rent_requirements",
                raw_message_id=9001,
            ),
            user={"id": "user-1"},
            tenant_id="workspace-1",
        )
    )

    assert calls == [(42, "residential_rent_requirements", 9001, "workspace-1")]
    parsed = urlparse(response["contact_url"])
    assert parsed.netloc == "wa.me"
    assert parsed.path == "/919876543210"
    message = parse_qs(parsed.query)["text"][0]
    assert "your 1 BHK requirement" in message
    assert "still active" in message
    assert "1 BHK" in message
    assert "Bandra West" in message
    assert "Bathrooms" not in message


def test_workspace_private_contact_is_not_exposed_to_another_tenant(monkeypatch):
    import routers.ai_chat as ai_chat
    from fastapi import HTTPException

    async def to_thread(func, /, *args, **kwargs):
        return func(*args, **kwargs)

    monkeypatch.setattr(
        ai_chat,
        "storage",
        SimpleNamespace(
            get_market_item_detail=lambda *args: {
                "id": 7,
                "broker_phone": "9876543210",
                "message_type": "listing",
                "visibility": "workspace_private",
                "tenant_id": "workspace-owner",
            }
        ),
    )
    monkeypatch.setattr(ai_chat.asyncio, "to_thread", to_thread)

    try:
        asyncio.run(
            ai_chat.resolve_broker_contact(
                7,
                ai_chat.BrokerContactRequest(source_schema="commercial_sale_listings"),
                user={"id": "user-2"},
                tenant_id="other-workspace",
            )
        )
    except HTTPException as exc:
        assert exc.status_code == 404
    else:
        raise AssertionError("workspace-private broker contact was exposed cross-tenant")


def test_listing_contact_uses_only_the_applicable_source_slice(monkeypatch):
    import routers.ai_chat as ai_chat

    async def to_thread(func, /, *args, **kwargs):
        return func(*args, **kwargs)

    class Query:
        def eq(self, *args):
            return self

        def execute(self):
            return SimpleNamespace(
                data=[{"message": "FULL BROADCAST: unrelated listing and 9876543210"}]
            )

    monkeypatch.setattr(
        ai_chat,
        "storage",
        SimpleNamespace(
            get_market_item_detail=lambda *args: {
                "id": 8,
                "broker_phone": "9876543210",
                "bhk": "2",
                "building_name": "Rustomjee Paramount",
                "micro_market": "Khar West",
                "message_type": "listing",
                "source_slice_text": "2 BHK at Rustomjee Paramount, Khar West for ₹9.68 Cr",
                "raw_message": "FULL BROADCAST: unrelated listing",
                "raw_payload": {"raw_message_id": 99},
            },
            client=SimpleNamespace(table=lambda *args: Query()),
        ),
    )
    monkeypatch.setattr(ai_chat.asyncio, "to_thread", to_thread)

    response = asyncio.run(
        ai_chat.resolve_broker_contact(
            8,
            ai_chat.BrokerContactRequest(
                source_schema="residential_sale_listings",
                raw_message_id=99,
            ),
            user={"id": "user-1"},
            tenant_id="workspace-1",
        )
    )

    message = parse_qs(urlparse(response["contact_url"]).query)["text"][0]
    assert "Rustomjee Paramount" in message
    assert "FULL BROADCAST" not in message
    assert "unrelated listing" not in message
