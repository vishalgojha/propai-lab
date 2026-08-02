def test_broker_context_is_private_and_personalized():
    import ai_chat_engine

    prompt = ai_chat_engine.build_conversational_system_prompt({
        "name": "Vishal Ojha",
        "phone": "9820056180",
        "city": "Mumbai",
        "listing_count": 12,
        "requirement_count": 4,
        "active_days_30": 18,
        "avg_ticket": 2.5,
    })

    assert "Vishal Ojha" in prompt
    assert "based in Mumbai" in prompt
    assert "12 tracked listings" in prompt
    assert "4 tracked requirements" in prompt
    assert "18 active days in the last 30 days" in prompt
    assert "Do not volunteer it" in prompt


def test_missing_broker_context_does_not_change_prompt():
    import ai_chat_engine

    prompt = ai_chat_engine.build_conversational_system_prompt(None)

    assert "CURRENT BROKER CONTEXT" not in prompt


def test_broker_context_scopes_profile_and_stats_to_tenant(monkeypatch):
    import routers.ai_chat as ai_chat

    class Query:
        def __init__(self):
            self.filters = []

        def select(self, _columns):
            return self

        def eq(self, column, value):
            self.filters.append((column, value))
            return self

        def limit(self, _count):
            return self

        def execute(self):
            return type("Result", (), {"data": [{
                "primary_phone": "9820056180",
                "canonical_name": "Vishal Ojha",
                "listing_count": 12,
            }]})()

    class Client:
        def __init__(self):
            self.query = Query()

        def table(self, _name):
            return self.query

    class Storage:
        def __init__(self):
            self.client = Client()
            self.profile_args = None

        def get_user_profile(self, **kwargs):
            self.profile_args = kwargs
            return {"phone": "9820056180", "first_name": "Vishal", "city": "Mumbai"}

    storage = Storage()
    monkeypatch.setattr(ai_chat, "storage", storage)

    context = ai_chat._load_chat_broker_context(
        {"broker_phone": "user:auth-user"},
        {"id": "auth-user"},
        "",
        "tenant-a",
    )

    assert context["name"] == "Vishal"
    assert storage.profile_args["tenant_id"] == "tenant-a"
    assert ("tenant_id", "tenant-a") in storage.client.query.filters
