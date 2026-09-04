"""Admin task-verifier health endpoint authorization and response contract."""
import asyncio
import json
import re

import routers.common as common
from fastapi import FastAPI

from routers import admin as admin_router


class FakeStorage:
    @staticmethod
    def is_super_admin(user_id):
        return user_id == "super-user"


def test_task_verifier_health_allows_super_admin_and_rejects_non_admin(monkeypatch):
    fake_storage = FakeStorage()
    monkeypatch.setattr(admin_router, "storage", fake_storage)
    monkeypatch.setattr(common, "storage", fake_storage)

    async def run_sync(function, *args, **kwargs):
        return function(*args, **kwargs)

    monkeypatch.setattr(admin_router.asyncio, "to_thread", run_sync)

    test_app = FastAPI()
    test_app.include_router(admin_router.router)
    current_user = {"id": "super-user"}

    async def fake_require_user():
        return current_user

    test_app.dependency_overrides[admin_router.require_user] = fake_require_user

    async def request():
        messages = []

        async def receive():
            return {"type": "http.request", "body": b"", "more_body": False}

        async def send(message):
            messages.append(message)

        await test_app(
            {
                "type": "http",
                "asgi": {"version": "3.0", "spec_version": "2.0"},
                "http_version": "1.1",
                "method": "GET",
                "scheme": "http",
                "path": "/api/admin/task-verifier/health",
                "raw_path": b"/api/admin/task-verifier/health",
                "query_string": b"",
                "headers": [],
                "client": ("test", 0),
                "server": ("test", 80),
            },
            receive,
            send,
        )
        status = next(message["status"] for message in messages if message["type"] == "http.response.start")
        body = next(message["body"] for message in messages if message["type"] == "http.response.body")
        return status, body

    status, body = asyncio.run(request())
    assert status == 200
    response = json.loads(body)
    assert response["status"] == "ok"
    assert response["service"] == "task-verifier"
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}T.*(?:\+00:00|Z)", response["checked_at"])

    current_user["id"] = "normal-user"
    status, _ = asyncio.run(request())
    assert status == 403
