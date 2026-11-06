import pytest
from fastapi import HTTPException

from routers.external_agent import _require_dm_consent


def test_private_dm_access_requires_workspace_consent():
    with pytest.raises(HTTPException, match="Private DM access is disabled"):
        _require_dm_consent({"scopes": ["raw_messages:dms"], "external_agent_dms_enabled": False})


def test_private_dm_access_requires_scope_even_after_consent():
    with pytest.raises(HTTPException, match="raw_messages:dms"):
        _require_dm_consent({"scopes": [], "external_agent_dms_enabled": True})


def test_private_dm_access_allows_consented_scoped_token():
    _require_dm_consent({"scopes": ["raw_messages:dms"], "external_agent_dms_enabled": True})
