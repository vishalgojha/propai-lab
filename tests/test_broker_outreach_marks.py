import asyncio
import pytest
from fastapi import HTTPException
import routers.brokers as b


class _Q:
    def __init__(self, db, name):
        self.db, self.name, self.f, self.op, self.row = db, name, {}, "select", None

    def select(self, *_): self.op = "select"; return self
    def eq(self, k, v): self.f[k] = v; return self
    def limit(self, *_): return self
    def upsert(self, row, on_conflict=None): self.op, self.row = "upsert", row; return self
    def delete(self): self.op = "delete"; return self

    def execute(self):
        t = self.db.setdefault(self.name, {})
        if self.op == "upsert":
            t[(self.row["organization_id"], self.row["broker_key"])] = dict(self.row)
        elif self.op == "delete":
            t.pop((self.f["organization_id"], self.f["broker_key"]), None)
        rows = [r for (o, _), r in t.items() if o == self.f.get("organization_id")]

        class R: data = rows
        return R()


class _Storage:
    def __init__(self, admin=True):
        self.db, self.admin = {}, admin
        self.client = self

    def table(self, name): return _Q(self.db, name)
    def is_super_admin(self, _): return self.admin


def run(c): return asyncio.run(c)
U = {"id": "u1"}


def test_roundtrip_and_tenant_isolation(monkeypatch):
    s = _Storage(); monkeypatch.setattr(b, "storage", s)
    run(b.set_outreach_mark({"broker_key": "bare:9876543210", "status": "sent"}, U, "org-a"))
    run(b.set_outreach_mark({"broker_key": "intl:919876543210", "status": "skipped"}, U, "org-a"))
    run(b.set_outreach_mark({"broker_key": "bare:9876543210", "status": "replied"}, U, "org-b"))
    a = {m["broker_key"]: m["status"] for m in run(b.list_outreach_marks(U, "org-a"))["marks"]}
    assert a == {"bare:9876543210": "sent", "intl:919876543210": "skipped"}
    assert [m["status"] for m in run(b.list_outreach_marks(U, "org-b"))["marks"]] == ["replied"]
    run(b.clear_outreach_mark({"broker_key": "bare:9876543210"}, U, "org-a"))
    assert list({m["broker_key"] for m in run(b.list_outreach_marks(U, "org-a"))["marks"]}) == ["intl:919876543210"]


@pytest.mark.parametrize("payload", [{"broker_key": "9876543210", "status": "sent"}, {"broker_key": "bare:98765", "status": "sent"},
                                     {"broker_key": "bare:9876543210", "status": "contacted"}, {"status": "sent"}])
def test_rejects_bad_input(monkeypatch, payload):
    monkeypatch.setattr(b, "storage", _Storage())
    with pytest.raises(HTTPException) as e:
        run(b.set_outreach_mark(payload, U, "org-a"))
    assert e.value.status_code == 400


def test_non_admin_forbidden(monkeypatch):
    monkeypatch.setattr(b, "storage", _Storage(admin=False))
    for fn, args in ((b.list_outreach_marks, (U, "o")), (b.set_outreach_mark, ({"broker_key": "bare:9876543210", "status": "sent"}, U, "o")),
                     (b.clear_outreach_mark, ({"broker_key": "bare:9876543210"}, U, "o"))):
        with pytest.raises(HTTPException) as e:
            run(fn(*args))
        assert e.value.status_code == 403
