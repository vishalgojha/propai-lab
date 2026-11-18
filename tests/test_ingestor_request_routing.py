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


def test_mutating_ingestor_request_does_not_replay_after_read_timeout(monkeypatch):
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
            raise httpx.ReadTimeout("reply timed out", request=httpx.Request(method, url))

    monkeypatch.setattr(common, "_ingestor_urls", lambda: [
        "http://ingestor:3001",
        "https://ingestor.example",
    ])
    monkeypatch.setattr(common.httpx, "AsyncClient", FakeClient)

    base_url, response = asyncio.run(
        common._first_ingestor_response("POST", "/pair-code/start", json={"phone": "919773757759"})
    )

    assert base_url == "http://ingestor:3001"
    assert response is None
    assert calls == [("POST", "http://ingestor:3001/pair-code/start")]


def test_pairing_setup_timeout_409_surfaces_ingestor_detail():
    response = httpx.Response(
        409,
        json={"error": "pairing session is still releasing; retry in a few seconds"},
        request=httpx.Request("POST", "http://ingestor:3001/pair-code/start"),
    )

    message = common._ingestor_failure_message(response)

    assert message == "pairing session is still releasing; retry in a few seconds"


def test_409_without_ingestor_detail_keeps_instance_message():
    response = httpx.Response(
        409,
        request=httpx.Request("POST", "http://ingestor:3001/connect"),
    )

    message = common._ingestor_failure_message(response)

    assert message == (
        "This phone session is active on another ingestor instance. "
        "Redeploy the ingestor once, then retry."
    )


def test_coded_503_keeps_the_ingestor_explanation_not_the_auth_message():
    response = httpx.Response(
        503,
        json={"error": "PropAI's database was too slow to start pairing.", "code": "db_timeout"},
        request=httpx.Request("POST", "http://ingestor:3001/pair-code/start"),
    )

    assert common._ingestor_failure_message(response) == "PropAI's database was too slow to start pairing."


def test_uncoded_503_still_reports_missing_ingestor_auth():
    response = httpx.Response(503, json={}, request=httpx.Request("POST", "http://ingestor:3001/x"))

    assert common._ingestor_failure_message(response) == "WhatsApp service authentication is not configured on the ingestor."
