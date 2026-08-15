"""OAuth helpers for a tenant-scoped remote Meta Ads MCP connection."""

from __future__ import annotations

import base64
import hashlib
import json
import os
import secrets
import time
from datetime import datetime, timedelta, timezone
from typing import Any
from urllib.parse import urlencode
import re

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


def _base_url() -> str:
    return os.getenv("META_ADS_MCP_URL", "https://mcp.facebook.com/ads").strip().rstrip("/")


async def metadata() -> dict[str, Any]:
    candidates = [
        "https://mcp.facebook.com/.well-known/oauth-protected-resource/ads",
        "https://mcp.facebook.com/.well-known/oauth-authorization-server",
    ]
    async with httpx.AsyncClient(timeout=httpx.Timeout(20.0, connect=8.0), follow_redirects=True) as client:
        for url in candidates:
            response = await client.get(url, headers={"Accept": "application/json"})
            if response.status_code < 400:
                data = response.json()
                authorization_servers = data.get("authorization_servers") if isinstance(data, dict) else []
                for server in authorization_servers or []:
                    oauth_url = f"{str(server).rstrip('/')}/.well-known/oauth-authorization-server"
                    oauth_response = await client.get(oauth_url, headers={"Accept": "application/json"})
                    if oauth_response.status_code < 400:
                        oauth = oauth_response.json()
                        if oauth.get("authorization_endpoint") and oauth.get("token_endpoint"):
                            return oauth
                if data.get("authorization_endpoint") and data.get("token_endpoint"):
                    return data
        # Some MCP servers publish only the protected-resource location in the
        # 401 challenge. This keeps discovery compatible with that transport.
        response = await client.get(_base_url(), headers={"Accept": "application/json"})
        resource_match = re.search(r'resource_metadata="([^"]+)"', response.headers.get("www-authenticate", ""), re.I)
        if resource_match:
            protected = await client.get(resource_match.group(1), headers={"Accept": "application/json"})
            protected_data = protected.json() if protected.status_code < 400 else {}
            for server in protected_data.get("authorization_servers") or []:
                oauth_response = await client.get(f"{str(server).rstrip('/')}/.well-known/oauth-authorization-server", headers={"Accept": "application/json"})
                if oauth_response.status_code < 400:
                    oauth = oauth_response.json()
                    if oauth.get("authorization_endpoint") and oauth.get("token_endpoint"):
                        return oauth
    raise RuntimeError("Meta Ads MCP OAuth metadata is unavailable")


async def begin(tenant_id: str, user_id: str, redirect_uri: str) -> dict[str, str]:
    oauth = await metadata()
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    client_id = os.getenv("META_ADS_MCP_CLIENT_ID", "").strip() or None
    client_secret = os.getenv("META_ADS_MCP_CLIENT_SECRET", "").strip() or None
    registration = oauth.get("registration_endpoint")
    if not client_id and registration:
        async with httpx.AsyncClient(timeout=20.0) as client:
            response = await client.post(registration, json={
                "client_name": "PropAI Ads Agent",
                "redirect_uris": [redirect_uri],
                "grant_types": ["authorization_code", "refresh_token"],
                "response_types": ["code"],
                "token_endpoint_auth_method": "none",
            })
            response.raise_for_status()
            registered = response.json()
            client_id = str(registered.get("client_id") or "") or None
            client_secret = str(registered.get("client_secret") or "") or None
    if not client_id:
        raise RuntimeError("Meta MCP OAuth client is not configured or dynamically registerable")
    storage.client.table("social_flow_meta_mcp_oauth_states").insert({
        "state": state, "tenant_id": tenant_id, "user_id": user_id,
        "code_verifier": verifier, "redirect_uri": redirect_uri,
        "client_id": client_id, "client_secret_encrypted": encrypt(client_secret),
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
    }).execute()
    query = {
        "response_type": "code", "client_id": client_id, "redirect_uri": redirect_uri,
        "state": state, "code_challenge": challenge, "code_challenge_method": "S256",
        "scope": os.getenv("META_ADS_MCP_SCOPES", "ads_read ads_management business_management"),
    }
    return {"authorization_url": f"{oauth['authorization_endpoint']}?{urlencode(query)}", "state": state}


async def finish(state: str, code: str) -> dict[str, Any]:
    rows = storage.client.table("social_flow_meta_mcp_oauth_states").select(
        "state,tenant_id,user_id,code_verifier,redirect_uri,client_id,client_secret_encrypted,expires_at"
    ).eq("state", state).limit(1).execute().data or []
    if not rows:
        raise RuntimeError("Meta OAuth state is invalid or expired")
    row = rows[0]
    if datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00")) < datetime.now(timezone.utc):
        raise RuntimeError("Meta OAuth state is expired")
    oauth = await metadata()
    payload = {
        "grant_type": "authorization_code", "code": code,
        "redirect_uri": row["redirect_uri"], "client_id": row["client_id"],
        "code_verifier": row["code_verifier"],
    }
    secret = decrypt(row.get("client_secret_encrypted"))
    if secret:
        payload["client_secret"] = secret
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(oauth["token_endpoint"], data=payload, headers={"Accept": "application/json"})
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
