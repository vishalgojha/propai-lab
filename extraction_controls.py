"""Source-specific extraction consent. Does not change capture or publication."""
import json
from contextvars import ContextVar


class ExtractionPaused(RuntimeError):
    """Control denial, not a provider failure or a consumed retry."""


provider_control = ContextVar("extraction_provider_control", default=None)
_business_intake = ContextVar("authorized_business_intake", default=None)


def process_business_intake(raw_id, ctx, storage, *, kind):
    """Called only after the existing WABA registration/confirmation or secret gate.

    Authorization is local to this synchronous call and exact source object.
    Stored labels, instance names and retry rows cannot recreate it.
    """
    if kind not in {"confirmed_waba_direct", "authenticated_waba_agent"}:
        raise ValueError("Unsupported business intake contract")
    if not ctx.get("tenant_id") or not raw_id:
        raise ExtractionPaused("Business intake requires tenant and raw evidence")
    from extraction import process_raw_message
    token = _business_intake.set((storage, ctx.get("tenant_id"), ctx))
    try:
        return process_raw_message(raw_id, ctx, storage)
    finally:
        _business_intake.reset(token)


def source_context(value):
    """Read routing identifiers only from existing raw source metadata."""
    def field(name, default=None):
        return value.get(name, default) if isinstance(value, dict) else getattr(value, name, default)
    payload = field("raw_payload", {})
    if isinstance(payload, str):
        try:
            payload = json.loads(payload)
        except (ValueError, TypeError):
            payload = {}
    payload = payload if isinstance(payload, dict) else {}
    data = payload.get("data", payload)
    data = data if isinstance(data, dict) else {}
    return {
        "broker_id": field("broker_id") or data.get("broker_id") or payload.get("broker_id"),
        "instance": field("instance") or data.get("instance") or payload.get("instance"),
    }


def extraction_allowed(storage, tenant_id, source):
    grant = _business_intake.get()
    if grant is not None and grant[0] is storage and grant[1] == tenant_id and grant[2] is source:
        return True
    check = getattr(storage, "is_extraction_allowed_for_source", None)
    if not callable(check):
        return False
    try:
        return bool(check(tenant_id, **source_context(source)))
    except Exception:
        return False


def require_extraction_allowed(storage, tenant_id, source):
    if not extraction_allowed(storage, tenant_id, source):
        raise ExtractionPaused("Extraction source is paused, unknown or unavailable")
