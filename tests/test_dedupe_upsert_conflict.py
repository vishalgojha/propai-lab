import httpx


def test_dedupe_claim_uses_ignore_duplicate_upsert():
    from storage.supabase import create_client

    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=[])

    client = create_client("https://example.supabase.co", "service-key")
    client._http = httpx.Client(
        transport=httpx.MockTransport(handler),
        base_url="https://example.supabase.co",
    )
    client.table("raw_message_dedupe_claims").upsert(
        {"tenant_id": "tenant-1", "author_content_fingerprint": "fp", "first_raw_message_id": 1},
        on_conflict="tenant_id,author_content_fingerprint",
        ignore_duplicates=True,
    ).execute()

    assert requests[0].headers["prefer"] == "resolution=ignore-duplicates,return=representation"
    assert "on_conflict=tenant_id%2Cauthor_content_fingerprint" in str(requests[0].url)
