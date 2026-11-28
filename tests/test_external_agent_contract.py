import asyncio

from starlette.requests import Request

from routers import external_agent


def _request(headers=None):
    raw_headers = [(key.lower().encode(), value.encode()) for key, value in (headers or {}).items()]
    return Request({"type": "http", "method": "GET", "path": "/contract", "headers": raw_headers})


def test_contract_manifest_and_body_share_the_same_revision_and_digest():
    body = asyncio.run(external_agent.external_agent_contract(_request()))
    manifest = asyncio.run(external_agent.external_agent_contract_manifest())
    digest = manifest["digest"].removeprefix("sha256:")

    assert body.headers["x-propai-contract"] == "propai.external-agent"
    assert body.headers["x-propai-contract-revision"] == manifest["revision"]
    assert body.headers["x-propai-contract-digest"] == manifest["digest"]
    assert body.headers["etag"] == f'"{digest}"'
    assert manifest["schema_revision"] == "external-v1"
    assert "Direct WhatsApp messages are not ingested" in body.body.decode("utf-8")


def test_contract_supports_etag_revalidation():
    first = asyncio.run(external_agent.external_agent_contract(_request()))
    second = asyncio.run(external_agent.external_agent_contract(_request({"if-none-match": first.headers["etag"]})))

    assert second.status_code == 304
    assert second.headers["etag"] == first.headers["etag"]


def test_capabilities_are_contract_bound_and_scope_filtered():
    result = asyncio.run(external_agent.external_agent_capabilities(key={
        "tenant_id": "tenant-1",
        "scopes": ["raw_messages:read", "inventory:write", "raw_messages:dms"],
    }))

    assert result["contract"] == "propai.external-agent"
    assert result["revision"] == external_agent.EXTERNAL_AGENT_CONTRACT_REVISION
    assert {operation["name"] for operation in result["operations"]["read"]} >= {
        "health", "search_group_messages", "get_group_message",
    }
    assert {operation["name"] for operation in result["operations"]["write"]} == {"create_inventory"}
    assert result["boundaries"]["direct_messages"] is False
    assert result["boundaries"]["media_ingestion"] is False
    assert result["knowledge"]["buildings_index_url"].endswith("/api/external/v1/knowledge/buildings")
    assert "{slug}" in result["knowledge"]["building_url_template"]
