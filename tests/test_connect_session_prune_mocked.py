"""Storage-mocked regression tests for the connect-session prune fix.

Runs in any venv with only pytest installed: every heavy dependency of
routers/external_agent.py (fastapi, pydantic, storage, registry, glossary) is
stubbed in sys.modules before import, and storage is an in-memory fake.

Covers the shipped defect: _prune_connect_sessions() deleted every session row
older than 1 day by expires_at (the 15-minute approval-link TTL), including
approved/consumed binding rows, which broke /connection-status for every
workspace whose binding predated the prune trigger.
"""

import asyncio
import sys
import types
from datetime import datetime, timedelta, timezone

import pytest

# ---------------------------------------------------------------------------
# Dependency stubs (installed before importing the module under test)
# ---------------------------------------------------------------------------


def _stub_module(name, **attrs):
    module = types.ModuleType(name)
    for key, value in attrs.items():
        setattr(module, key, value)
    sys.modules[name] = module
    return module


class _HTTPException(Exception):
    def __init__(self, status_code, detail=None):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail


def _route_decorator(self, *args, **kwargs):
    return lambda func: func


class _APIRouter:
    def __init__(self, *args, **kwargs):
        pass

    get = post = put = delete = patch = _route_decorator


def _Depends(callable_=None, *args, **kwargs):
    return callable_


def _Header(default=None, **kwargs):
    return default


def _Query(default=None, **kwargs):
    return default


class _Request:  # pragma: no cover - shape only
    pass


class _Response:
    def __init__(self, content=None, **kwargs):
        self.content = content


class _BaseModel:
    def __init__(self, **kwargs):
        annotations = {}
        for klass in reversed(type(self).__mro__):
            annotations.update(getattr(klass, "__annotations__", {}))
        for field in annotations:
            if field in kwargs:
                setattr(self, field, kwargs[field])
            elif hasattr(type(self), field):
                setattr(self, field, getattr(type(self), field))
            else:
                setattr(self, field, None)


def _Field(default=None, default_factory=None, **kwargs):
    if default_factory is not None:
        return default_factory()
    return default


class _AmbiguousLocality(Exception):
    pass


_stub_module(
    "fastapi",
    APIRouter=_APIRouter,
    Depends=_Depends,
    Header=_Header,
    HTTPException=_HTTPException,
    Query=_Query,
    Request=_Request,
)
_stub_module("fastapi.responses", JSONResponse=_Response, PlainTextResponse=_Response)
_stub_module("pydantic", BaseModel=_BaseModel, Field=_Field)
_stub_module("domain_glossary", build_ai_domain_context=lambda *a, **k: "")
_stub_module(
    "registry.search_locality",
    resolve_search_locality=lambda *a, **k: None,
    AmbiguousLocality=_AmbiguousLocality,
)
_stub_module("registry.locality_resolver", _fetch_all=lambda *a, **k: [])


class _FakeResult:
    def __init__(self, data):
        self.data = data


class _FakeQuery:
    """Minimal supabase-py query-builder facsimile over a row list."""

    def __init__(self, db, table):
        self.db = db
        self.table = table
        self.mode = "select"
        self.payload = None
        self.filters = []
        self._order = None
        self._limit = None

    def select(self, cols="*"):
        self.mode = "select"
        return self

    def insert(self, row):
        self.mode = "insert"
        self.payload = row
        return self

    def update(self, patch):
        self.mode = "update"
        self.payload = patch
        return self

    def delete(self):
        self.mode = "delete"
        return self

    def eq(self, col, val):
        self.filters.append(("eq", col, val))
        return self

    def in_(self, col, vals):
        self.filters.append(("in", col, list(vals)))
        return self

    def is_(self, col, val):
        self.filters.append(("is", col, val))
        return self

    def lt(self, col, val):
        self.filters.append(("lt", col, val))
        return self

    def order(self, col, desc=False):
        self._order = (col, desc)
        return self

    def limit(self, n):
        self._limit = n
        return self

    def _matches(self, row):
        for op, col, val in self.filters:
            rv = row.get(col)
            if op == "eq" and not (rv == val or (rv is not None and str(rv) == str(val))):
                return False
            if op == "in" and rv not in val:
                return False
            if op == "is":
                if val == "null" and rv is not None:
                    return False
                if val != "null" and rv is None:
                    return False
            if op == "lt" and not (rv is not None and str(rv) < str(val)):
                return False
        return True

    def execute(self):
        rows = self.db.setdefault(self.table, [])
        if self.mode == "insert":
            rows.append(dict(self.payload))
            return _FakeResult([dict(self.payload)])
        matched = [r for r in rows if self._matches(r)]
        if self.mode == "delete":
            self.db[self.table] = [r for r in rows if not self._matches(r)]
            return _FakeResult([dict(r) for r in matched])
        if self.mode == "update":
            for row in matched:
                row.update(self.payload)
            return _FakeResult([dict(r) for r in matched])
        out = [dict(r) for r in matched]
        if self._order:
            col, desc = self._order
            out.sort(key=lambda r: str(r.get(col) or ""), reverse=desc)
        if self._limit is not None:
            out = out[: self._limit]
        return _FakeResult(out)


class _FakeClient:
    def __init__(self, db):
        self.db = db

    def table(self, name):
        return _FakeQuery(self.db, name)


class _FakeStorage:
    def __init__(self, db):
        self.client = _FakeClient(db)


FAKE_DB = {}
_stub_module("storage", set_tenant_id=lambda *a, **k: None, get_tenant_id=lambda *a, **k: None)
_stub_module(
    "routers.common",
    _require_org_permission=lambda *a, **k: asyncio.sleep(0),
    require_tenant=lambda *a, **k: None,
    require_user=lambda *a, **k: None,
    storage=_FakeStorage(FAKE_DB),
)

sys.path.insert(0, str(__file__.rsplit("/tests/", 1)[0]))

# Load routers/external_agent.py without running the real routers/__init__.py
# (which pulls the whole app). A stub package with __path__ pointing at the
# real directory lets the submodule import while skipping the package init.
_REPO_ROOT = __file__.rsplit("/tests/", 1)[0]
_routers_pkg = types.ModuleType("routers")
_routers_pkg.__path__ = [_REPO_ROOT + "/routers"]
sys.modules["routers"] = _routers_pkg

import routers.external_agent as ea  # noqa: E402

SESSIONS = "external_agent_connect_sessions"
KEYS = "external_agent_api_keys"
ORGS = "organizations"

NOW = datetime.now(timezone.utc)
OLD = (NOW - timedelta(days=2)).isoformat()
RECENT = (NOW - timedelta(hours=1)).isoformat()


def _session_row(**overrides):
    row = {
        "id": "sess-1",
        "tenant_id": "tenant-a",
        "status": "pending",
        "label": "Instinct",
        "write_access": False,
        "api_key_id": None,
        "approved_by": None,
        "user_code": "AAAA-BBBB",
        "device_code_hash": "x" * 64,
        "token": None,
        "created_at": OLD,
        "decided_at": None,
        "expires_at": OLD,
    }
    row.update(overrides)
    return row


@pytest.fixture(autouse=True)
def clean_db():
    FAKE_DB.clear()
    yield
    FAKE_DB.clear()


# ---------------------------------------------------------------------------
# 1. Approved + collected (consumed) binding survives pruning and stays linked
# ---------------------------------------------------------------------------


def test_consumed_binding_survives_prune_and_connection_status_stays_linked():
    FAKE_DB[SESSIONS] = [
        _session_row(status="consumed", api_key_id="key-1", approved_by="owner-1", decided_at=OLD)
    ]
    FAKE_DB[KEYS] = [
        {
            "id": "key-1",
            "tenant_id": "tenant-a",
            "created_by": "owner-1",
            "label": "Instinct",
            "key_prefix": "ppai_testpref",
            "scopes": ["raw_messages:read"],
            "expires_at": None,
            "revoked_at": None,
            "last_used_at": OLD,
            "created_at": OLD,
        }
    ]
    FAKE_DB[ORGS] = [
        {"id": "tenant-a", "external_agent_dms_enabled": False, "external_agent_dms_consented_at": None}
    ]

    ea._prune_connect_sessions()

    assert len(FAKE_DB[SESSIONS]) == 1, "consumed binding row must never be pruned"

    status = asyncio.run(ea.external_connection_status(user={"id": "owner-1"}, tenant_id="tenant-a"))
    assert status["connection"] is not None
    assert status["connection"]["key_id"] == "key-1"
    assert status["connection"]["key_revoked"] is False
    assert status["connection"]["can_read_groups"] is True
    assert status["unbound_active_keys"] == 0


# ---------------------------------------------------------------------------
# 2. Approved-but-uncollected rows survive (they are the key's delivery path)
# ---------------------------------------------------------------------------


def test_approved_uncollected_binding_survives_prune():
    FAKE_DB[SESSIONS] = [
        _session_row(
            status="approved",
            api_key_id="key-2",
            approved_by="owner-1",
            decided_at=OLD,
            token="sealed-secret-still-awaiting-collection",
        )
    ]
    ea._prune_connect_sessions()
    assert len(FAKE_DB[SESSIONS]) == 1, "approved-uncollected row holds a minted key binding"
    assert FAKE_DB[SESSIONS][0]["token"] == "sealed-secret-still-awaiting-collection"


# ---------------------------------------------------------------------------
# 3. Only never-minted rows older than the cutoff are pruned
# ---------------------------------------------------------------------------


def test_unbound_rows_pruned_only_when_old_and_never_minted():
    FAKE_DB[SESSIONS] = [
        _session_row(id="old-pending", status="pending"),
        _session_row(id="old-declined", status="declined", decided_at=OLD),
        _session_row(id="old-expired", status="pending", expires_at=OLD),
        _session_row(id="recent-pending", status="pending", created_at=RECENT, expires_at=RECENT),
        _session_row(id="bound", status="consumed", api_key_id="key-9", decided_at=OLD),
    ]
    ea._prune_connect_sessions()
    surviving = {row["id"] for row in FAKE_DB[SESSIONS]}
    assert surviving == {"recent-pending", "bound"}


# ---------------------------------------------------------------------------
# 4. Cross-tenant: creating a session for one workspace cannot touch another's
# ---------------------------------------------------------------------------


def test_session_creation_preserves_other_tenant_bindings():
    FAKE_DB[SESSIONS] = [
        _session_row(
            id="tenant-b-binding",
            tenant_id="tenant-b",
            status="consumed",
            api_key_id="key-b",
            decided_at=OLD,
        )
    ]
    FAKE_DB[KEYS] = [
        {
            "id": "key-b",
            "tenant_id": "tenant-b",
            "created_by": "owner-b",
            "label": "Instinct",
            "key_prefix": "ppai_tenantb",
            "scopes": ["raw_messages:read"],
            "expires_at": None,
            "revoked_at": None,
            "last_used_at": OLD,
            "created_at": OLD,
        }
    ]
    FAKE_DB[ORGS] = [
        {"id": "tenant-b", "external_agent_dms_enabled": False, "external_agent_dms_consented_at": None}
    ]

    body = ea.ConnectSessionCreate(label="New agent", write_access=False)
    created = asyncio.run(ea.create_connect_session(body))
    assert created["expires_in"] == 900 and created["device_code"]

    bindings = [r for r in FAKE_DB[SESSIONS] if r.get("id") == "tenant-b-binding"]
    assert len(bindings) == 1, "tenant B's binding row must survive tenant A's session creation"
    assert len(FAKE_DB[KEYS]) == 1, "no key row may be touched"

    status = asyncio.run(ea.external_connection_status(user={"id": "owner-b"}, tenant_id="tenant-b"))
    assert status["connection"] is not None, "tenant B still linked after cross-tenant prune"


# ---------------------------------------------------------------------------
# 5. Bound key still authenticates (health 200) after a prune cycle
# ---------------------------------------------------------------------------


def test_bound_key_health_unaffected_by_prune():
    token = "ppai_" + "a" * 43  # KEY_PREFIX + >=40 chars total
    FAKE_DB[SESSIONS] = [
        _session_row(status="consumed", api_key_id="key-1", decided_at=OLD)
    ]
    FAKE_DB[KEYS] = [
        {
            "id": "key-1",
            "tenant_id": "tenant-a",
            "created_by": "owner-1",
            "label": "Instinct",
            "key_hash": ea._digest(token),
            "scopes": ["raw_messages:read"],
            "expires_at": None,
            "revoked_at": None,
            "last_used_at": None,
            "created_at": OLD,
        }
    ]
    FAKE_DB[ORGS] = [
        {"id": "tenant-a", "external_agent_dms_enabled": False}
    ]

    ea._prune_connect_sessions()

    key = asyncio.run(ea.external_auth(authorization=None, x_api_key=token))
    health = asyncio.run(ea.external_health(key))
    assert health == {"ok": True, "tenant_scoped": True, "scopes": ["raw_messages:read"]}
