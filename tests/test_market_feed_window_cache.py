import types

import storage.supabase as supabase_mod
from storage.supabase import SupabaseStorage


class _Clock:
    def __init__(self, start: float = 1000.0) -> None:
        self.t = start

    def monotonic(self) -> float:
        return self.t


def _store() -> SupabaseStorage:
    store = SupabaseStorage.__new__(SupabaseStorage)
    store._market_feed_window_cache = {}
    return store


def test_window_cache_reuses_tier_instead_of_rebuilding(monkeypatch):
    store = _store()
    clock = _Clock()
    monkeypatch.setattr(supabase_mod, "time", clock)
    builds: list[int] = []

    def build(window: int) -> list[dict]:
        builds.append(window)
        return [{"id": i} for i in range(window)]

    key = ("all", "all", "", (), None, False, "all", True)
    first = store._cached_market_feed_window(cache_key=key, required=50, build=build)
    assert builds == [250]
    assert len(first) == 250

    second = store._cached_market_feed_window(cache_key=key, required=120, build=build)
    assert builds == [250]
    assert second is first

    upgraded = store._cached_market_feed_window(cache_key=key, required=400, build=build)
    assert builds == [250, 500]
    assert len(upgraded) == 500


def test_window_cache_expires_after_ttl(monkeypatch):
    store = _store()
    clock = _Clock()
    monkeypatch.setattr(supabase_mod, "time", clock)
    builds: list[int] = []

    def build(window: int) -> list[dict]:
        builds.append(window)
        return []

    key = ("all", "all", "", (), None, False, "all", True)
    store._cached_market_feed_window(cache_key=key, required=50, build=build)
    clock.t += supabase_mod._MARKET_FEED_WINDOW_TTL_SECONDS + 1
    store._cached_market_feed_window(cache_key=key, required=50, build=build)
    assert builds == [250, 250]


def test_window_cache_is_bounded(monkeypatch):
    store = _store()
    monkeypatch.setattr(supabase_mod, "time", _Clock())
    cap = supabase_mod._MARKET_FEED_WINDOW_CACHE_MAX
    for index in range(cap + 6):
        store._cached_market_feed_window(cache_key=("k", index), required=10, build=lambda _w: [])
    assert len(store._market_feed_window_cache) == cap


def test_feed_page_load_more_reuses_one_window_build(monkeypatch):
    store = _store()
    monkeypatch.setattr(supabase_mod, "time", _Clock())
    builds: list[int] = []

    def fake_feed(self, *, limit, offset=0, **kwargs):
        builds.append(limit)
        return [{"id": i} for i in range(limit)]

    store.get_market_items_feed = types.MethodType(fake_feed, store)
    store._get_market_feed_quality_counts = types.MethodType(
        lambda self, **kwargs: {"sample_total": 745, "visible": 745, "needs_review": 0},
        store,
    )

    first = store.get_market_items_feed_page(limit=50, offset=0)
    second = store.get_market_items_feed_page(limit=50, offset=50)

    assert builds == [250]
    assert [item["id"] for item in first["items"]] == list(range(0, 50))
    assert [item["id"] for item in second["items"]] == list(range(50, 100))
    assert first["total"] == 745
    assert second["total"] == 745
