"""Scaffold tests: signature verification and fail-closed config gating."""
import hashlib
import hmac

import pytest

from routers.billing import verify_webhook_signature


def test_webhook_signature_accepts_valid():
    body = b'{"event":"subscription.activated"}'
    secret = "whsec_test"
    sig = hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert verify_webhook_signature(body, sig, secret) is True


def test_webhook_signature_rejects_invalid():
    body = b'{"event":"subscription.activated"}'
    assert verify_webhook_signature(body, "deadbeef", "whsec_test") is False


def test_webhook_signature_rejects_empty_signature():
    assert verify_webhook_signature(b"{}", "", "whsec_test") is False


def test_subscription_create_fails_closed_without_keys():
    from fastapi import HTTPException
    from routers.billing import _require_keys, _KEY_ID, _KEY_SECRET

    if _KEY_ID or _KEY_SECRET:
        pytest.skip("env keys present in this environment")
    with pytest.raises(HTTPException) as exc:
        _require_keys()
    assert exc.value.status_code == 503
