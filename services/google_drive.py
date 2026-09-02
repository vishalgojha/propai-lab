"""Google Drive OAuth and Sheets export helpers for PropAI."""

from __future__ import annotations

import base64
import hashlib
import os
import secrets
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

import httpx

from services.meta_mcp_oauth import decrypt, encrypt
from routers.common import storage


DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file"
SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets"
IDENTITY_SCOPES = ("openid", "email", "profile")


def _client_id() -> str:
    return os.getenv("GOOGLE_DRIVE_CLIENT_ID", "").strip()


def _client_secret() -> str:
    return os.getenv("GOOGLE_DRIVE_CLIENT_SECRET", "").strip()


def _redirect_uri() -> str:
    return os.getenv("GOOGLE_DRIVE_REDIRECT_URI", "https://app.propai.live/api/google-drive/callback").strip()


async def begin(tenant_id: str, user_id: str) -> str:
    if not _client_id() or not _client_secret():
        raise RuntimeError("GOOGLE_DRIVE_CLIENT_ID and GOOGLE_DRIVE_CLIENT_SECRET are required")
    state = secrets.token_urlsafe(32)
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    storage.client.table("google_drive_oauth_states").insert({
        "state": state, "tenant_id": tenant_id, "user_id": user_id,
        "code_verifier": verifier, "redirect_uri": _redirect_uri(),
        "expires_at": (datetime.now(timezone.utc) + timedelta(minutes=10)).isoformat(),
    }).execute()
    query = urlencode({
        "client_id": _client_id(), "redirect_uri": _redirect_uri(), "response_type": "code",
        "access_type": "offline", "prompt": "consent", "state": state,
        "code_challenge": challenge, "code_challenge_method": "S256",
        "scope": " ".join((*IDENTITY_SCOPES, DRIVE_SCOPE, SHEETS_SCOPE)),
    })
    return f"https://accounts.google.com/o/oauth2/v2/auth?{query}"


async def finish(state: str, code: str) -> dict:
    rows = storage.client.table("google_drive_oauth_states").select("*").eq("state", state).limit(1).execute().data or []
    if not rows:
        raise RuntimeError("Google Drive OAuth state is invalid or expired")
    row = rows[0]
    if datetime.fromisoformat(str(row["expires_at"]).replace("Z", "+00:00")) < datetime.now(timezone.utc):
        raise RuntimeError("Google Drive OAuth state is expired")
    async with httpx.AsyncClient(timeout=30) as client:
        token_response = await client.post("https://oauth2.googleapis.com/token", data={
            "code": code, "client_id": _client_id(), "client_secret": _client_secret(),
            "redirect_uri": row["redirect_uri"], "grant_type": "authorization_code",
            "code_verifier": row["code_verifier"],
        })
        token_response.raise_for_status()
        token = token_response.json()
        access_token = str(token.get("access_token") or "")
        refresh_token = str(token.get("refresh_token") or "")
        if not access_token:
            raise RuntimeError("Google did not return an access token")
        user_response = await client.get("https://www.googleapis.com/oauth2/v3/userinfo", headers={"Authorization": f"Bearer {access_token}"})
        user_response.raise_for_status()
        profile = user_response.json()
    existing = (storage.client.table("google_drive_connections").select("refresh_token_encrypted").eq("tenant_id", row["tenant_id"]).limit(1).execute().data or [None])[0]
    refresh_token = refresh_token or (existing or {}).get("refresh_token_encrypted")
    if not refresh_token:
        raise RuntimeError("Google did not return an offline token; reconnect and approve offline access")
    expires_in = int(token.get("expires_in") or 3600)
    storage.client.table("google_drive_connections").upsert({
        "tenant_id": row["tenant_id"], "google_subject": str(profile.get("sub") or ""),
        "google_email": str(profile.get("email") or ""),
        "access_token_encrypted": encrypt(access_token), "access_token_expires_at": (datetime.now(timezone.utc) + timedelta(seconds=max(60, expires_in - 60))).isoformat(), "refresh_token_encrypted": encrypt(refresh_token) if not existing or refresh_token != existing.get("refresh_token_encrypted") else refresh_token,
        "scopes": [*IDENTITY_SCOPES, DRIVE_SCOPE, SHEETS_SCOPE], "status": "connected",
        "connected_by": row["user_id"], "last_validated_at": datetime.now(timezone.utc).isoformat(),
    }, on_conflict="tenant_id").execute()
    storage.client.table("google_drive_oauth_states").delete().eq("state", state).execute()
    return {"tenant_id": row["tenant_id"], "email": str(profile.get("email") or "")}


def refresh_access_token(refresh_token: str) -> str:
    response = httpx.post("https://oauth2.googleapis.com/token", data={
        "client_id": _client_id(), "client_secret": _client_secret(),
        "refresh_token": refresh_token, "grant_type": "refresh_token",
    }, timeout=30)
    response.raise_for_status()
    return str(response.json().get("access_token") or "")


def connection_token(row: dict) -> str:
    token = decrypt(row.get("access_token_encrypted"))
    refresh = decrypt(row.get("refresh_token_encrypted"))
    expires_at = row.get("access_token_expires_at")
    expired = False
    if expires_at:
        try:
            expired = datetime.fromisoformat(str(expires_at).replace("Z", "+00:00")) <= datetime.now(timezone.utc)
        except ValueError:
            expired = True
    if (not token or expired) and refresh:
        token = refresh_access_token(refresh)
    if not token:
        raise RuntimeError("Google Drive connection has no usable token")
    return token


def drive_request(method: str, url: str, token: str, **kwargs):
    headers = dict(kwargs.pop("headers", {}) or {})
    headers["Authorization"] = f"Bearer {token}"
    headers.setdefault("Accept", "application/json")
    response = httpx.request(method, url, headers=headers, timeout=45, **kwargs)
    response.raise_for_status()
    return response.json() if response.content else {}
