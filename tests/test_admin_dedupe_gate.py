import httpx

from storage.supabase import create_client


def test_dedupe_gate_index_predicate_is_postgrest_compatible():
    requests = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append({"url": str(request.url), "prefer": request.headers.get("prefer", "")})
        return httpx.Response(200, json=[{"id": 1}], headers={"content-range": "0-0/1"})

    client = create_client("https://example.supabase.co", "service-key")
    client._http = httpx.Client(
        transport=httpx.MockTransport(handler),
        base_url="https://example.supabase.co",
    )

    client.table("raw_messages").select("id").not_.is_(
        "repeat_of_raw_message_id", "null"
    ).eq("extraction_outcome", "repeat_observation").order(
        "timestamp", desc=True
    ).limit(100).execute()
    client.table("raw_messages").select("id", count="exact").not_.is_(
        "repeat_of_raw_message_id", "null"
    ).eq("extraction_outcome", "repeat_observation").execute()

    feed_url = requests[0]["url"]
    total_url = requests[1]["url"]
    assert "repeat_of_raw_message_id=not.is.null" in feed_url
    assert "extraction_outcome=eq.repeat_observation" in feed_url
    assert "repeat_of_raw_message_id=not.is.null" in total_url
    assert "extraction_outcome=eq.repeat_observation" in total_url
    assert requests[1]["prefer"] == "count=exact"
