"""OAuth helpers for a tenant-scoped remote Meta Ads MCP connection."""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode

import httpx
from cryptography.fernet import Fernet

from routers.common import storage


def _fernet() -> Fernet:
    raw = os.getenv("PROPAI_TOKEN_ENCRYPTION_KEY", "").strip()
    if raw:
        key = raw.encode()
    else:
        secret = os.getenv("SUPABASE_JWT_SECRET", "").encode()
        key = base64.urlsafe_b64encode(hashlib.sha256(secret).digest())
    if not key or not os.getenv("SUPABASE_JWT_SECRET") and not raw:
        raise RuntimeError("PROPAI_TOKEN_ENCRYPTION_KEY or SUPABASE_JWT_SECRET is required")
    return Fernet(key)


def encrypt(value: str | None) -> str | None:
    return _fernet().encrypt(value.encode()).decode() if value else None


def decrypt(value: str | None) -> str:
    return _fernet().decrypt(value.encode()).decode() if value else ""


def _graph_version() -> str:
    return os.getenv("META_GRAPH_API_VERSION", "v21.0").strip()


def _app_id() -> str:
    return os.getenv("META_APP_ID", "").strip()


def _app_secret() -> str:
    return os.getenv("META_APP_SECRET", "").strip()


async def begin(tenant_id: str, user_id: str, redirect_uri: str) -> dict[str, str]:
    client_id = _app_id()
    if not client_id or not _app_secret():
        raise RuntimeError("META_APP_ID and META_APP_SECRET are required")
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    storage.client.table("social_flow_meta_mcp_oauth_states").insert({
        "state": state, "tenant_id": tenant_id, "user_id": user_id,
        "code_verifier": verifier, "redirect_uri": redirect_uri,
        "client_id": client_id, "client_secret_encrypted": encrypt(_app_secret()),
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
    }).execute()
    query = {
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri,
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
        "scope": os.getenv("META_ADS_SCOPES", "ads_read,ads_management,business_management,pages_show_list,pages_read_engagement"),
    }
    endpoint = f"https://www.facebook.com/{_graph_version()}/dialog/oauth"
    return {"authorization_url": f"{endpoint}?{urlencode(query)}", "state": state}


async def finish(state: str, code: str) -> dict[str, Any]:
    rows = storage.client.table("social_flow_meta_mcp_oauth_states").select(
        "state,tenant_id,user_id,code_verifier,redirect_uri,client_id,client_secret_encrypted,expires_at"
    ).eq("state", state).limit(1).execute().data or []
    if not rows:
        raise RuntimeError("Meta OAuth state is invalid or expired")
    row = rows[0]
    if datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00")) < datetime.now(timezone.utc):
        raise RuntimeError("Meta OAuth state is expired")
    payload = {
        "grant_type": "authorization_code", "code": code,
        "redirect_uri": row["redirect_uri"], "client_id": row["client_id"],
        "code_verifier": row["code_verifier"],
    }
    secret = decrypt(row.get("client_secret_encrypted"))
    if secret:
        payload["client_secret"] = secret
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"https://graph.facebook.com/{_graph_version()}/oauth/access_token",
            params={**payload, "client_secret": secret or _app_secret()},
            headers={"Accept": "application/json"},
        )
        response.raise_for_status()
        token = response.json()
    access_token = str(token.get("access_token") or "")
    if not access_token:
        raise RuntimeError("Meta OAuth did not return an access token")
    expires_in = int(token.get("expires_in") or 0)
    storage.client.table("social_flow_meta_mcp_connections").upsert({
        "tenant_id": row["tenant_id"], "access_token_encrypted": encrypt(access_token),
        "refresh_token_encrypted": encrypt(str(token.get("refresh_token") or "")),
        "token_type": str(token.get("token_type") or "Bearer"),
        "expires_at": (datetime.now(timezone.utc) + timedelta(seconds=expires_in)).isoformat() if expires_in else None,
        "scopes": str(token.get("scope") or "").split(), "connected_by": row["user_id"],
    }, on_conflict="tenant_id").execute()
    storage.client.table("social_flow_meta_mcp_oauth_states").delete().eq("state", state).execute()
    return {"tenant_id": row["tenant_id"], "user_id": row["user_id"]}


def access_token(tenant_id: str) -> str:
    rows = storage.client.table("social_flow_meta_mcp_connections").select(
        "access_token_encrypted,expires_at"
    ).eq("tenant_id", tenant_id).limit(1).execute().data or []
    if not rows:
        return ""
    expires_at = rows[0].get("expires_at")
    if expires_at and datetime.fromisoformat(str(expires_at).replace("Z", "+00:00")) < datetime.now(timezone.utc):
        return ""
    return decrypt(rows[0].get("access_token_encrypted"))
