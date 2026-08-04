from routers.protection import SlidingWindowLimiter, TTLCache, bounded_page


def test_bounded_page_caps_limit_and_offset():
    assert bounded_page(5000, 50000, maximum=100) == (100, 10000)
    assert bounded_page(-5, -1, maximum=100) == (1, 0)


def test_sliding_window_limiter_rejects_after_limit():
    limiter = SlidingWindowLimiter()

    assert limiter.allow("user-1", "search", 2, window_seconds=60)[0] is True
    assert limiter.allow("user-1", "search", 2, window_seconds=60)[0] is True
    allowed, remaining, retry_after = limiter.allow("user-1", "search", 2, window_seconds=60)

    assert allowed is False
    assert remaining == 0
    assert retry_after >= 1


def test_ttl_cache_returns_values_and_evicts_when_full():
    cache = TTLCache(max_entries=1, ttl_seconds=60)
    cache.set("a", {"ok": True})
    assert cache.get("a") == {"ok": True}

    cache.set("b", {"ok": False})
    assert cache.get("a") is None
    assert cache.get("b") == {"ok": False}
