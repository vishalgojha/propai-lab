import pytest
from fastapi import HTTPException

from routers.external_agent import _require_dm_consent


def test_private_dm_access_is_retired_even_with_legacy_consent():
    with pytest.raises(HTTPException, match="not supported"):
        _require_dm_consent({"scopes": ["raw_messages:dms"], "external_agent_dms_enabled": True})


def test_private_dm_access_is_retired_without_scope():
    with pytest.raises(HTTPException, match="not supported"):
        _require_dm_consent({"scopes": [], "external_agent_dms_enabled": True})


def test_private_dm_access_never_allows_a_legacy_scoped_token():
    with pytest.raises(HTTPException, match="not supported"):
        _require_dm_consent({"scopes": ["raw_messages:dms"], "external_agent_dms_enabled": True})
