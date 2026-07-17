from datetime import datetime, timedelta, timezone

import jwt

import app


def test_verify_supabase_token_accepts_configured_hs256_secret(monkeypatch):
    secret = "test-secret-with-enough-entropy-for-hs256"
    monkeypatch.setattr(app, "SUPABASE_JWT_SECRET", secret)
    token = jwt.encode(
        {
            "sub": "user-123",
            "aud": "authenticated",
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
        },
        secret,
        algorithm="HS256",
    )

    payload = app.verify_supabase_token(token)

    assert payload is not None
    assert payload["sub"] == "user-123"


def test_verify_supabase_token_rejects_hs256_with_wrong_secret(monkeypatch):
    monkeypatch.setattr(app, "SUPABASE_JWT_SECRET", "configured-secret")
    token = jwt.encode(
        {
            "sub": "user-123",
            "aud": "authenticated",
            "exp": datetime.now(timezone.utc) + timedelta(minutes=5),
        },
        "different-secret",
        algorithm="HS256",
    )

    assert app.verify_supabase_token(token) is None
