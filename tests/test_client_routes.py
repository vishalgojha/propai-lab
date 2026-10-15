"""Route-level wiring tests for the clients module.

These call the FastAPI route coroutines directly with a mocked storage so a
missing method or a signature drift is caught without a live database.
"""

import asyncio
from unittest.mock import MagicMock

import pytest

import routers.clients as clients


@pytest.fixture
def store(monkeypatch):
    fake = MagicMock(name="storage")
    monkeypatch.setattr(clients, "storage", fake)
    return fake


def _run(coro):
    return asyncio.run(coro)


def test_list_clients_trims_to_limit(store):
    store.get_clients.return_value = [{"id": 1}, {"id": 2}, {"id": 3}]
    result = _run(clients.list_clients(q="", limit=2, user={"id": "u"}))
    assert result == [{"id": 1}, {"id": 2}]
    store.get_clients.assert_called_once_with("")


def test_get_client_embeds_requirements_and_candidates(store):
    store.get_client.return_value = {"id": 4, "name": "Ravi"}
    store.get_client_requirements.return_value = [{"id": 9}]
    store.get_client_candidates.return_value = [{"id": 7}]
    result = _run(clients.get_client(client_id=4, user={"id": "u"}))
    assert result["requirements"] == [{"id": 9}]
    assert result["candidates"] == [{"id": 7}]


def test_get_client_missing_returns_404(store):
    from fastapi.responses import JSONResponse

    store.get_client.return_value = None
    result = _run(clients.get_client(client_id=99, user={"id": "u"}))
    assert isinstance(result, JSONResponse)
    assert result.status_code == 404


def test_update_client_forwards_only_body_fields(store):
    result = _run(clients.update_client(client_id=4, body={"name": "New"}, user={"id": "u"}))
    assert result == {"ok": True}
    store.update_client.assert_called_once_with(4, name="New")


def test_add_requirement_uppercases_intent(store):
    store.add_client_requirement.return_value = 12
    body = {"intent": "rent", "bhk": "3 BHK", "price_max": 4}
    result = _run(clients.add_requirement(client_id=4, body=body, user={"id": "u"}))
    assert result == {"id": 12}
    assert store.add_client_requirement.call_args.args[1] == "RENT"
    assert store.add_client_requirement.call_args.kwargs["bhk"] == "3 BHK"


def test_add_note_requires_body(store):
    from fastapi.responses import JSONResponse

    result = _run(clients.add_client_note(client_id=4, body={}, user={"id": "u"}))
    assert isinstance(result, JSONResponse)
    assert result.status_code == 400
    store.add_client_note.assert_not_called()


def test_add_alias_conflict_returns_409(store):
    from fastapi.responses import JSONResponse

    store.add_client_alias.return_value = None
    result = _run(clients.add_client_alias(client_id=4, body={"alias": "Ravi"}, user={"id": "u"}))
    assert isinstance(result, JSONResponse)
    assert result.status_code == 409


def test_list_notes_clamps_limit(store):
    store.get_client_notes.return_value = []
    _run(clients.list_client_notes(client_id=4, active_only=True, limit=100000, user={"id": "u"}))
    assert store.get_client_notes.call_args.kwargs["limit"] == 500


def test_list_aliases_and_messages(store):
    store.get_client_aliases.return_value = [{"id": 1, "alias": "Ravi"}]
    store.get_client_messages.return_value = {"messages": [], "total": 0}
    assert _run(clients.list_client_aliases(client_id=4, user={"id": "u"}))[0]["alias"] == "Ravi"
    assert _run(clients.get_client_messages(client_id=4, limit=100, offset=0, user={"id": "u"}))["total"] == 0


def test_requirement_match_routes_use_storage(store):
    store.match_requirements.return_value = 3
    store.get_match_summary.return_value = [{"requirement_id": 5, "match_count": 2, "best_score": 0.9}]
    store.get_requirement_matches.return_value = [{"listing_id": 1}]
    assert _run(clients.match_requirements(user={"id": "u"}, tenant_id="t"))["matched"] == 3
    summary = _run(clients.requirement_matches_summary(user={"id": "u"}, tenant_id="t"))
    assert summary["5"] == {"count": 2, "best": 0.9}
    matches = _run(clients.requirement_matches(req_id=5, limit=20, user={"id": "u"}, tenant_id="t"))
    assert matches["count"] == 1
    store.get_requirement_matches.assert_called_once_with(5, 20)
