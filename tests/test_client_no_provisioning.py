from routers import common as _common


class _Storage:
    def __init__(self, client=False, lookup_error=False):
        self.client = client
        self.lookup_error = lookup_error
        self.created = []

    def get_user_organizations(self, uid):
        return []

    def is_client_account(self, uid):
        if self.lookup_error:
            raise RuntimeError("db down")
        return self.client

    def get_organization_by_owner_user_id(self, uid):
        return None

    def get_organization_by_owner_phone(self, phone):
        return None

    def get_organization_by_slug(self, slug):
        return None

    def create_organization(self, **kw):
        self.created.append(kw)
        return None


USER = {"id": "u1", "email": "c@example.com", "user_metadata": {"phone": "919800000000"}}


def test_client_account_is_never_provisioned_a_workspace(monkeypatch):
    st = _Storage(client=True)
    monkeypatch.setattr(_common, "storage", st)
    assert _common._resolve_user_organization_id(USER) is None
    assert st.created == []


def test_client_lookup_failure_blocks_provisioning(monkeypatch):
    st = _Storage(lookup_error=True)
    monkeypatch.setattr(_common, "storage", st)
    assert _common._resolve_user_organization_id(USER) is None
    assert st.created == []


def test_non_client_still_provisions(monkeypatch):
    st = _Storage(client=False)
    monkeypatch.setattr(_common, "storage", st)
    _common._resolve_user_organization_id(USER)
    assert len(st.created) == 1
