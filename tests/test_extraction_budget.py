"""Unit tests for the extraction worker's spend budget guard."""

from extraction_worker import _cumulative_extraction_spend, remaining_budget


class _Resp:
    def __init__(self, data):
        self.data = data


class _Chain:
    def __init__(self, resp):
        self._resp = resp

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def execute(self):
        return self._resp


def _storage_with_rows(rows):
    return type("S", (), {"client": type("C", (), {"table": lambda self, _n: _Chain(_Resp(rows))})()})()


def test_cumulative_spend_sums_extraction_cost():
    storage = _storage_with_rows([{"cost_usd": 1.5}, {"cost_usd": "2.25"}, {"cost_usd": None}])
    assert _cumulative_extraction_spend(storage) == 3.75


def test_cumulative_spend_skips_bad_values():
    storage = _storage_with_rows([{"cost_usd": "not-a-number"}, {"cost_usd": 0.5}, {"cost_usd": {}}])
    assert _cumulative_extraction_spend(storage) == 0.5


def test_cumulative_spend_returns_zero_on_error():
    storage = type("S", (), {"client": None})()
    assert _cumulative_extraction_spend(storage) == 0.0


def test_cumulative_spend_handles_empty_table():
    storage = _storage_with_rows([])
    assert _cumulative_extraction_spend(storage) == 0.0


def test_remaining_budget_none_when_unlimited():
    storage = _storage_with_rows([{"cost_usd": 50}])
    assert remaining_budget(storage, None) is None


def test_remaining_budget_subtracts_spend():
    storage = _storage_with_rows([{"cost_usd": 10}, {"cost_usd": 5}])
    assert remaining_budget(storage, 50) == 35.0


def test_remaining_budget_floors_at_zero():
    storage = _storage_with_rows([{"cost_usd": 60}])
    assert remaining_budget(storage, 50) == 0.0
