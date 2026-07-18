import asyncio
from types import SimpleNamespace

import app


def test_shared_waba_is_available_to_super_admin(monkeypatch):
    values = {
        "whatsapp_business_number": app.PROPAI_SHARED_WABA_NUMBER,
        "phone_number_id": "phone-number-id",
        "access_token": "token",
        "verify_token": "verify",
    }

    class Storage:
        @staticmethod
        def is_super_admin(user_id):
            return user_id == "super-user"

    monkeypatch.setattr(app, "storage", Storage())
    monkeypatch.setattr(
        app,
        "_companion_get_config_value",
        lambda key, _env_key="": values.get(key, ""),
    )

    super_config = asyncio.run(app.companion_config(user={"id": "super-user"}))
    broker_config = asyncio.run(app.companion_config(user={"id": "broker-user"}))

    assert super_config["waba_owner"] == "propai"
    assert super_config["outbound_allowed"] is True
    assert broker_config["outbound_allowed"] is False


def test_waba_webhook_stores_inbound_message_once(monkeypatch):
    calls = []

    class Database:
        def execute(self, sql, params=()):
            calls.append((sql, params))
            return SimpleNamespace(rowcount=1)

    class Request:
        async def json(self):
            return {
                "object": "whatsapp_business_account",
                "entry": [{
                    "changes": [{
                        "value": {
                            "contacts": [{"profile": {"name": "Broker One"}}],
                            "messages": [{
                                "from": "919999999999",
                                "id": "wamid.test",
                                "type": "text",
                                "text": {"body": ""},
                            }],
                        },
                    }],
                }],
            }

    monkeypatch.setattr(app, "storage", SimpleNamespace(db=Database()))
    monkeypatch.setattr(app, "_waba_session_update", lambda *_args, **_kwargs: None)

    result = asyncio.run(app.companion_webhook_receive(Request()))

    raw_insert = next(sql for sql, _params in calls if "INSERT INTO raw_messages" in sql)
    assert "ON CONFLICT DO NOTHING" in raw_insert
    assert result["processed"] == [{
        "type": "message_stored",
        "from": "919999999999",
        "msg_type": "text",
    }]
