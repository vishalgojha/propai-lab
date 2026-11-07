import asyncio
import pytest
from fastapi import HTTPException

from routers.external_agent import external_auth


def test_external_auth_accepts_x_api_key(monkeypatch):
    monkeypatch.setattr("routers.external_agent._key_row", lambda token: {"token": token})
    result = asyncio.run(external_auth(None, "ppai_test"))
    assert result == {"token": "ppai_test"}


def test_external_auth_accepts_bearer(monkeypatch):
    monkeypatch.setattr("routers.external_agent._key_row", lambda token: {"token": token})
    result = asyncio.run(external_auth("Bearer ppai_test", None))
    assert result == {"token": "ppai_test"}


def test_external_auth_rejects_conflicting_headers():
    with pytest.raises(HTTPException, match="Conflicting"):
        asyncio.run(external_auth("Bearer ppai_one", "ppai_two"))
