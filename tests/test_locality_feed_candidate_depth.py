import sys, types
sys.path.insert(0, '.')
from storage.supabase import SupabaseStorage

def make_storage(rows):
    s = object.__new__(SupabaseStorage)
    s._tenant_id = 't1'
    s._market_quality_counts_cache = None
    s._market_feed_window_cache = {}
    def fake_fetch(*, tenant_id=None, limit=500, offset=0, intent='', result_type='all',
                   asset_type='all', network_wide=False, include_quarantined=True, since_ts=None):
        target = max(100, limit + offset)
        return rows[:target], {}
    s._fetch_recent_market_typed_rows = fake_fetch
    s._filter_workspace_blocked_rows = lambda merged, **kw: merged
    return s

def row(i, locality, building):
    return {
        'id': i, 'raw_message_id': 1000 + i, '_typed_table': 'residential_rent_listings',
        'locality_resolved': locality, 'micro_market': '', 'locality_raw': '',
        'locality_sub_locality': '', 'locality_parent_locality': '', 'locality_canonical_locality': '',
        'building_name_canonical': building, 'visibility': 'shared', 'tenant_id': 'other',
        'created_at': '2026-11-17T00:%02d:00Z' % (i % 60), 'updated_at': '', 'last_seen_at': '',
        'raw_payload': {}, 'listing_index': None, 'duplicate_status': '',
        'bhk': str(1 + i % 4), 'configuration': str(1 + i % 4),
        'price': 50000 + i, 'quote': 50000 + i, 'rent_amount': 50000 + i,
        'area_sqft': 500 + i, 'floor': str(i % 20), 'broker_phone': '90000%05d' % i,
        'intent': 'RENT', 'transaction_type': 'rent', 'asset_type': 'residential',
        'property_type': 'apartment',
    }

ROWS = [row(i, 'Andheri', 'Andheri Heights %d' % i) for i in range(250)] + \
       [row(250 + i, 'Bandra West', 'Bandra View %d' % i) for i in range(250)]

def test_locality_page_not_empty_and_total_consistent():
    s = make_storage(ROWS)
    page = s.get_market_items_feed_page(limit=50, offset=0, market_localities=['Bandra West'],
                                        tenant_id='t1', source_state='extracted')
    assert len(page['items']) == 50, f"page empty/short: {len(page['items'])}"
    assert page['total'] == 250, f"total {page['total']}"
    assert page['total_scope'] == 'bounded_recent_market_sample'

def test_pagination_edges_within_sample():
    s = make_storage(ROWS)
    p4 = s.get_market_items_feed_page(limit=50, offset=150, market_localities=['Bandra West'],
                                      tenant_id='t1', source_state='extracted')
    assert len(p4['items']) == 50
    p5 = s.get_market_items_feed_page(limit=50, offset=200, market_localities=['Bandra West'],
                                      tenant_id='t1', source_state='extracted')
    assert len(p5['items']) == 50
    p6 = s.get_market_items_feed_page(limit=50, offset=250, market_localities=['Bandra West'],
                                      tenant_id='t1', source_state='extracted')
    assert len(p6['items']) == 0 and p6['total'] == 250

def test_no_locality_regression():
    s = make_storage(ROWS)
    page = s.get_market_items_feed_page(limit=50, offset=0, tenant_id='t1', source_state='extracted')
    assert len(page['items']) == 50
    assert page['total'] == 500

def test_merged_reposts_count_and_page_consistent():
    # 120 Andheri reposts of one flat (same building+message hash collapses),
    # then 400 Bandra West singles: merge must not resurrect the 250/500 divergence
    reps = [row(i, 'Andheri', 'Repost Plaza') for i in range(120)]
    for r in reps:
        r['raw_message_id'] = 5555  # same message -> intra-message collapse
    singles = [row(500 + i, 'Bandra West', 'BW House %d' % i) for i in range(400)]
    s = make_storage(reps + singles)
    page = s.get_market_items_feed_page(limit=50, offset=0, market_localities=['Bandra West'],
                                        tenant_id='t1', source_state='extracted')
    assert len(page['items']) == 50
    # 520 fixture rows exceed the shared 500-row sample: both the page and
    # the total see the same bounded sample (120 reposts + 380 singles).
    assert page['total'] == 380
