from types import SimpleNamespace

from storage.supabase import _RestClient


def test_rest_client_exposes_storage_bucket_adapter():
    client = _RestClient("https://example.supabase.co", "service-key")
    bucket = client.storage.from_("private-crm")
    assert bucket._bucket == "private-crm"
    assert bucket._client is client
    client.close()


def test_storage_upload_uses_storage_api_and_boolean_upsert_header(monkeypatch):
    client = _RestClient("https://example.supabase.co", "service-key")
    captured = {}

    def fake_post(url, **kwargs):
        captured.update(url=url, kwargs=kwargs)
        return SimpleNamespace(text="{}", json=lambda: {}, raise_for_status=lambda: None)

    monkeypatch.setattr(client._http, "post", fake_post)
    client.storage.from_("private-crm").upload(
        "tenant/user/file.txt", b"hello", {"content-type": "text/plain", "upsert": "false"}
    )
    assert captured["url"] == "https://example.supabase.co/storage/v1/object/private-crm/tenant/user/file.txt"
    assert captured["kwargs"]["content"] == b"hello"
    assert captured["kwargs"]["headers"] == {"Content-Type": "text/plain"}
    client.close()
