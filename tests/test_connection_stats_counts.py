import ast
import time
from pathlib import Path
from types import SimpleNamespace


def stats_method():
    tree = ast.parse(Path('storage/supabase.py').read_text())
    cls = next(n for n in tree.body if isinstance(n, ast.ClassDef) and any(getattr(m, 'name', '') == 'get_stats' for m in n.body))
    method = next(n for n in cls.body if isinstance(n, ast.FunctionDef) and n.name == 'get_stats')
    ns = dict(time=time, _ALL_TYPED_TABLES=['listings_a', 'listings_b', 'requirements_a'], _TYPED_LISTING_TABLE_NAMES=['listings_a', 'listings_b'], _TYPED_REQUIREMENT_TABLE_NAMES=['requirements_a'])
    exec(compile(ast.Module(body=[method], type_ignores=[]), '<stats-test>', 'exec'), ns)
    return ns['get_stats']


class Query:
    def __init__(self, client, table): self.client, self.table_name = client, table
    def select(self, field, **kwargs):
        assert field == 'id' and kwargs == dict(count='exact')
        return self
    def limit(self, value):
        assert value == 0
        return self
    def eq(self, key, value):
        assert (key, value) == ('tenant_id', 'tenant-a')
        return self
    def execute(self):
        self.client.calls.append(self.table_name)
        if self.client.fail: raise RuntimeError('unavailable')
        return SimpleNamespace(count=self.client.counts[self.table_name])


class Client:
    def __init__(self):
        self.calls, self.fail = [], False
        self.counts = dict(listings_a=4, listings_b=3, requirements_a=2, raw_messages=15, brokers=5, buildings=6)
    def table(self, table): return Query(self, table)


def test_exact_count_parity_tenant_scope_and_single_scan():
    client = Client()
    obj = SimpleNamespace(tenant_id=None, _stats_cache={}, client=client)
    result = stats_method()(obj, 'tenant-a')
    assert result == dict(total_messages=15, total_parsed=9, total_listings=7, total_requirements=2, total_brokers=5, total_buildings=6, stats_available=True)
    assert len(client.calls) == len(set(client.calls)) == 6
    stats_method()(obj, 'tenant-a')
    assert len(client.calls) == 6


def test_failure_keeps_stale_values_and_marks_unavailable():
    client = Client(); client.fail = True
    obj = SimpleNamespace(tenant_id=None, _stats_cache={'tenant-a': (0, {'total_parsed': 19})}, client=client)
    assert stats_method()(obj, 'tenant-a') == {'total_parsed': 19, 'stats_available': False}
