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

        @staticmethod
        def get_user_organizations(_user_id):
            return [{"id": "org-broker"}]

        @staticmethod
        def get_org_waba_connection(org_id):
            assert org_id == "org-broker"
            return None

    monkeypatch.setattr(app, "storage", Storage())
    monkeypatch.setattr(
        app,
        "_business_api_get_config_value",
        lambda key, _env_key="": values.get(key, ""),
    )

    super_config = asyncio.run(app.business_api_config(user={"id": "super-user"}, tenant_id="org-admin"))
    broker_config = asyncio.run(app.business_api_config(user={"id": "broker-user"}, tenant_id="org-broker"))

    assert super_config["waba_owner"] == "propai"
    assert super_config["outbound_allowed"] is True
    assert broker_config["outbound_allowed"] is False
    assert broker_config["whatsapp_business_number"] == ""
    assert broker_config["phone_number_id"] == ""
    assert broker_config["access_token_preview"] == ""
    assert broker_config["verify_token_preview"] == ""
    assert broker_config["webhook_callback_url"].endswith("/org-broker")


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

    monkeypatch.setattr(
        app,
        "storage",
        SimpleNamespace(
            db=Database(),
            get_org_waba_connection_by_phone_number_id=lambda _phone_id: None,
        ),
    )
    monkeypatch.setattr(app, "_waba_session_update", lambda *_args, **_kwargs: None)

    result = asyncio.run(app.business_api_webhook_receive(Request()))

    raw_insert = next(sql for sql, _params in calls if "INSERT INTO raw_messages" in sql)
    assert "ON CONFLICT DO NOTHING" in raw_insert
    assert result["processed"] == [{
        "type": "message_stored",
        "from": "919999999999",
        "msg_type": "text",
    }]


def test_workspace_waba_webhook_resolves_by_phone_number_id(monkeypatch):
    workspace = {
        "organization_id": "org-one",
        "phone_number_id": "workspace-phone-id",
        "access_token": "workspace-token",
        "verify_token": "workspace-verify",
        "is_active": True,
    }
    monkeypatch.setattr(
        app,
        "storage",
        SimpleNamespace(
            get_org_waba_connection_by_phone_number_id=lambda phone_id: (
                workspace if phone_id == "workspace-phone-id" else None
            )
        ),
    )

    body = {
        "entry": [{
            "changes": [{
                "value": {
                    "metadata": {"phone_number_id": "workspace-phone-id"},
                    "messages": [],
                }
            }]
        }]
    }
    values, org_id = asyncio.run(app._resolve_waba_webhook_config(body))

    assert values["access_token"] == "workspace-token"
    assert org_id == "org-one"


def test_propai_shared_waba_number_is_valid_indian_mobile():
    assert app.PROPAI_SHARED_WABA_NUMBER == "+917021045254"
    assert app._mobile_digits(app.PROPAI_SHARED_WABA_NUMBER) == "7021045254"
