import json
import os

import pytest
from fastapi import HTTPException

os.environ.setdefault("SUPABASE_URL", "https://x.supabase.co")
os.environ.setdefault("SUPABASE_SERVICE_ROLE_KEY", "test")
os.environ.setdefault("SUPABASE_JWT_SECRET", "test-secret")
os.environ.setdefault("COOLIFY_API_URL", "http://coolify.test")
os.environ.setdefault("COOLIFY_API_TOKEN", "test-token")

from routers import admin_ops


def test_extract_coolify_action_restart():
    marker = '[PROPAI_COOLIFY_ACTION]{"action":"restart","resource":"fpmr99xoi9qc7bdclals8jzb","summary":"Restart stale worker"}[/PROPAI_COOLIFY_ACTION]'
    content, action = admin_ops._extract_coolify_action(f"head {marker} tail")
    assert action == {
        "operation": "coolify_restart",
        "resource": "fpmr99xoi9qc7bdclals8jzb",
        "summary": "Restart stale worker",
    }
    assert content == "head  tail"


def test_extract_coolify_action_redeploy():
    marker = '[PROPAI_COOLIFY_ACTION]{"action":"redeploy","resource":"fpmr99xoi9qc7bdclals8jzb","summary":"Redeploy"}[/PROPAI_COOLIFY_ACTION]'
    content, action = admin_ops._extract_coolify_action(marker)
    assert action["operation"] == "coolify_redeploy"
    assert content.strip() == ""


@pytest.mark.parametrize(
    "marker",
    [
        '[PROPAI_COOLIFY_ACTION]{"action":"delete","resource":"fpmr99xoi9qc7bdclals8jzb"}[/PROPAI_COOLIFY_ACTION]',
        '[PROPAI_COOLIFY_ACTION]{"action":"restart","resource":"<script>alert(1)</script>"}[/PROPAI_COOLIFY_ACTION]',
        '[PROPAI_COOLIFY_ACTION]{"action":"restart"}[/PROPAI_COOLIFY_ACTION]',
        '[PROPAI_COOLIFY_ACTION]not json[/PROPAI_COOLIFY_ACTION]',
        '[PROPAI_COOLIFY_ACTION]["not","a","dict"][/PROPAI_COOLIFY_ACTION]',
    ],
)
def test_extract_coolify_action_rejects_invalid(marker):
    content, action = admin_ops._extract_coolify_action(f"keep {marker}")
    assert action is None
    assert "keep" in content
    assert "PROPAI_COOLIFY_ACTION" not in content


def test_extract_coolify_action_absent():
    content, action = admin_ops._extract_coolify_action("plain text")
    assert action is None
    assert content == "plain text"


def test_extract_both_db_and_coolify_in_order():
    db = '[PROPAI_DB_ACTION]{"operation":"update_row","table":"settings","row_id":"2","values":{"flag":true},"summary":"flip flag"}[/PROPAI_DB_ACTION]'
    cool = '[PROPAI_COOLIFY_ACTION]{"action":"restart","resource":"fpmr99xoi9qc7bdclals8jzb","summary":"restart worker"}[/PROPAI_COOLIFY_ACTION]'
    text = f"a {db} b {cool} c"
    remaining, db_action = admin_ops._extract_db_action(text)
    remaining, cool_action = admin_ops._extract_coolify_action(remaining)
    assert db_action["operation"] == "update_row"
    assert cool_action["operation"] == "coolify_restart"
    assert remaining.strip() == "a  b  c"


def test_coolify_approval_token_round_trip():
    action = {"operation": "coolify_restart", "resource": "fpmr99xoi9qc7bdclals8jzb", "summary": "restart"}
    token = admin_ops._make_db_approval_token("tenant-a", "user-1", action)
    parsed = admin_ops._read_db_approval_token(token, "tenant-a", "user-1")
    assert parsed == action


def test_coolify_approval_token_tenant_bound():
    action = {"operation": "coolify_restart", "resource": "fpmr99xoi9qc7bdclals8jzb", "summary": "restart"}
    token = admin_ops._make_db_approval_token("tenant-a", "user-1", action)
    with pytest.raises(HTTPException):
        admin_ops._read_db_approval_token(token, "tenant-b", "user-1")
    with pytest.raises(HTTPException):
        admin_ops._read_db_approval_token(token, "tenant-a", "user-2")


def test_coolify_approval_token_tampered():
    action = {"operation": "coolify_restart", "resource": "fpmr99xoi9qc7bdclals8jzb", "summary": "restart"}
    token = admin_ops._make_db_approval_token("tenant-a", "user-1", action) + "x"
    with pytest.raises(HTTPException):
        admin_ops._read_db_approval_token(token, "tenant-a", "user-1")


def test_coolify_operations_whitelist():
    assert admin_ops._COOLIFY_OPERATIONS == {"coolify_restart", "coolify_redeploy"}