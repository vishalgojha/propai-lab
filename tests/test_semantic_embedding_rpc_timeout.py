"""Live regression test for the bounded semantic-search RPC.

Run explicitly with SUPABASE_URL and SUPABASE_SERVICE_KEY against a deployed
database. It is skipped in the normal unit-test suite because it performs a
live RPC call.
"""

from __future__ import annotations

import os
import time

import httpx
import pytest


@pytest.mark.skipif(
    not (os.getenv("SUPABASE_URL") and os.getenv("SUPABASE_SERVICE_KEY")),
    reason="requires a configured Supabase project",
)
def test_noisy_semantic_rpc_is_bounded():
    base_url = os.environ["SUPABASE_URL"].rstrip("/")
    service_key = os.environ["SUPABASE_SERVICE_KEY"]
    # A deliberately noisy vector exercises the no-good-match path without
    # requiring an embedding-provider call during this regression test.
    vector = "[" + ",".join(["0"] * 1024) + "]"
    payload = {
        "p_query_embedding": vector,
        "p_entity_types": ["building_alias"],
        "p_tenant_id": None,
        "p_limit": 20,
        "p_min_similarity": 0.99,
        "p_model": "voyageai/voyage-4-lite",
    }
    started = time.monotonic()
    response = httpx.post(
        f"{base_url}/rest/v1/rpc/match_semantic_embeddings",
        headers={"apikey": service_key, "Authorization": f"Bearer {service_key}"},
        json=payload,
        timeout=5.0,
    )
    elapsed = time.monotonic() - started
    response.raise_for_status()
    assert elapsed < 5.0
