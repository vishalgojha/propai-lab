import asyncio

import httpx

from routers import common


def test_mutating_ingestor_request_stops_after_first_http_response(monkeypatch):
    calls = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def request(self, method, url, **kwargs):
            calls.append((method, url))
            return httpx.Response(502, request=httpx.Request(method, url))

    monkeypatch.setattr(common, "_ingestor_urls", lambda: [
        "http://ingestor:3001",
        "https://ingestor.example",
    ])
    monkeypatch.setattr(common.httpx, "AsyncClient", FakeClient)

    base_url, response = asyncio.run(
        common._first_ingestor_response("POST", "/pair-code", json={"phone": "919773757759"})
    )

    assert base_url == "http://ingestor:3001"
    assert response is not None
    assert response.status_code == 502
    assert calls == [("POST", "http://ingestor:3001/pair-code")]


def test_mutating_ingestor_request_falls_back_only_when_alias_is_unreachable(monkeypatch):
    calls = []

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def request(self, method, url, **kwargs):
            calls.append((method, url))
            if url.startswith("http://ingestor:3001"):
                raise httpx.ConnectError("unreachable", request=httpx.Request(method, url))
            return httpx.Response(200, request=httpx.Request(method, url), json={"ok": True})

    monkeypatch.setattr(common, "_ingestor_urls", lambda: [
        "http://ingestor:3001",
        "https://ingestor.example",
    ])
    monkeypatch.setattr(common.httpx, "AsyncClient", FakeClient)

    base_url, response = asyncio.run(
        common._first_ingestor_response("POST", "/pair-code", json={"phone": "919773757759"})
    )

    assert base_url == "https://ingestor.example"
    assert response is not None
    assert response.status_code == 200
    assert calls == [
        ("POST", "http://ingestor:3001/pair-code"),
        ("POST", "https://ingestor.example/pair-code"),
    ]
