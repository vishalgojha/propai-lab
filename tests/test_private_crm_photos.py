import io
from types import SimpleNamespace
import pytest
from fastapi import HTTPException
from PIL import Image
from private_crm_photos import normalize_photo, private_bucket, photo_path, save_photo, read_photo


def image_bytes(fmt="PNG"):
    out = io.BytesIO()
    Image.new("RGB", (8, 12), "red").save(out, format=fmt)
    return out.getvalue()


def test_validation_and_metadata_stripping():
    cleaned = normalize_photo(image_bytes())
    img = Image.open(io.BytesIO(cleaned))
    assert img.format == "JPEG" and img.size == (8, 12)
    assert not img.getexif()
    assert cleaned == normalize_photo(image_bytes())


@pytest.mark.parametrize("data", [b"<svg>bad</svg>", b"video", b"", b"x" * (10 * 1024 * 1024 + 1)])
def test_reject_invalid_or_large(data):
    with pytest.raises(HTTPException): normalize_photo(data)


def test_private_bucket_fail_closed():
    for public in [True, None]:
        client = SimpleNamespace(_base_url="https://example.invalid", _http=SimpleNamespace(get=lambda url: SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"public": public})))
        with pytest.raises(HTTPException): private_bucket(client)


class Query:
    def __init__(self, client, table): self.client, self.table, self.filters, self.payload = client, table, {}, None
    def select(self, *args): return self
    def eq(self, key, value): self.filters[key] = value; return self
    def limit(self, *args): return self
    def order(self, *args): return self
    def upsert(self, payload, **kwargs): self.payload = payload; return self
    def execute(self):
        if self.payload:
            if not any(r["storage_path"] == self.payload["storage_path"] for r in self.client.rows):
                self.client.rows.append({**self.payload, "id": len(self.client.rows) + 1})
        source = self.client.targets if self.table == "crm_inventory" else self.client.rows
        return SimpleNamespace(data=[r for r in source if all(r.get(k) == v for k,v in self.filters.items())])


class Client:
    _base_url = "https://example.invalid"
    def __init__(self):
        self.rows = []; self.targets = [{"id": 1, "tenant_id": "a"}]; self.uploads = []
        self._http = SimpleNamespace(get=lambda url: SimpleNamespace(raise_for_status=lambda: None, json=lambda: {"public": False}))
        self.storage = SimpleNamespace(from_=lambda bucket: SimpleNamespace(upload=lambda path, content, opts: self.uploads.append(path)))
    def table(self, name): return Query(self, name)


def test_target_tenant_and_photo_idor():
    c = Client()
    with pytest.raises(HTTPException) as exc: save_photo(c, "b", 1, "user", image_bytes())
    assert exc.value.status_code == 404 and not c.uploads
    with pytest.raises(HTTPException): read_photo(c, "b", 1, 1)


def test_idempotent_retry_same_flat_not_global():
    c = Client(); c.targets.append({"id": 2, "tenant_id": "a"})
    one = save_photo(c, "a", 1, "user", image_bytes())
    two = save_photo(c, "a", 1, "user", image_bytes())
    assert one["id"] == two["id"] and two["duplicate"] and len(c.uploads) == 1
    save_photo(c, "a", 2, "user", image_bytes())
    assert len(c.uploads) == 2 and len(c.rows) == 2


def test_scope_is_separate():
    from routers.external_agent import _require_scope
    with pytest.raises(HTTPException): _require_scope({"scopes": ["inventory:write"]}, "photos:write")

def test_search_uses_production_query_builder(monkeypatch):
    import asyncio
    from routers import external_agent
    from storage.supabase import _QueryBuilder
    seen = []
    class Rest:
        def table(self, name): return _QueryBuilder(self, name)
        def _execute(self, query):
            seen.append(query)
            return SimpleNamespace(data=[])
    monkeypatch.setattr(external_agent, 'storage', SimpleNamespace(client=Rest()))
    result = asyncio.run(external_agent.external_inventory_search(q='Slope', limit=10, offset=20, key={'tenant_id':'a','scopes':['inventory:read']}))
    assert result['records'] == []
    assert seen[0]._offset == 20 and seen[0]._limit == 10
    assert ('tenant_id', 'eq', 'a') in seen[0]._filters
