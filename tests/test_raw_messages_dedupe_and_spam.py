from storage.supabase import (
    SupabaseStorage,
    _dedupe_raw_reposts,
    _is_raw_spam_broadcast,
)


def test_hiring_broadcast_is_spam_but_property_posts_are_not():
    assert _is_raw_spam_broadcast(
        "We are hiring urgently for Sales & Field Executive. Share your CV on whatsapp"
    ) is True
    assert _is_raw_spam_broadcast(
        "Candidate required for customer care work from home, KYC documents"
    ) is True
    # Real property vocabulary vetoes spam so hybrid ads stay visible.
    assert _is_raw_spam_broadcast("3 BHK flat for rent in Bandra, 45,000 per month") is False
    assert _is_raw_spam_broadcast("Urgent sale 1 BHK at 1.2 crore, call RK") is False
    assert _is_raw_spam_broadcast("ok") is False


def test_strong_hiring_survives_property_words_like_salary_and_office():
    # Real hiring ads that quote a salary, name an office or call themselves
    # "real estate" must still be hidden: property words no longer veto them.
    assert _is_raw_spam_broadcast(
        "WE ARE HIRING | BDE / BDM Industry: Real Estate - Secondary Market "
        "Location: Sector 4, Greater Noida West Salary: Up to Rs 35,000"
    ) is True
    assert _is_raw_spam_broadcast(
        "URGENT HIRING | SALES & FIELD EXECUTIVE (MALE / FEMALE). We're hiring! "
        "JOB. Maruti Real Estate is looking for experienced candidates"
    ) is True
    assert _is_raw_spam_broadcast(
        "HIRING - FEMALE BACK OFFICE EXECUTIVE Industry: Real Estate "
        "Location: Behind Mc Donald lane, send your resume"
    ) is True
    assert _is_raw_spam_broadcast(
        "We're Hiring | Roswalt Realty - real estate sales professionals to join our team"
    ) is True


def test_genuine_listing_is_rescued_from_hiring_words():
    # A real listing that happens to mention a job word stays visible because it
    # carries a listing signal (unit / rent / sale / possession).
    assert _is_raw_spam_broadcast(
        "3 BHK flat for rent, vacancy for family, possession immediate, broker please"
    ) is False
    assert _is_raw_spam_broadcast(
        "Office space on lease 1200 sq ft, one staff sitting, call for details"
    ) is False
    assert _is_raw_spam_broadcast(
        "2 BHK sale in Andheri, 1.2 crore, job not required only direct buyer"
    ) is False


def test_dedupe_keeps_newest_member_of_direct_head_chains():
    # Newest-first rows. repeat_of points at the chain head (the first post),
    # matching the raw_messages.repeat_of_raw_message_id backfill.
    rows = [
        {"id": 30, "message": "latest repost"},
        {"id": 20, "message": "middle repost", "repeat_of_raw_message_id": 10},
        {"id": 10, "message": "original"},
    ]
    rows[0]["repeat_of_raw_message_id"] = 10
    repeat_map = {10: 0, 20: 10, 30: 10}
    kept = _dedupe_raw_reposts(rows, repeat_map)
    assert [row["id"] for row in kept] == [30]


def test_dedupe_keeps_independent_messages():
    rows = [{"id": 3}, {"id": 2}, {"id": 1}]
    assert [row["id"] for row in _dedupe_raw_reposts(rows, {})] == [3, 2, 1]


def test_dedupe_collapses_duplicate_content_without_repeat_of():
    # Extraction lags ingest, so fresh rows have repeat_of_raw_message_id=None.
    # Identical bodies must still collapse to the newest copy.
    rows = [
        {"id": 40, "message": "3 BHK for rent in Bandra East 30k", "repeat_of_raw_message_id": None},
        {"id": 30, "message": "3 BHK for rent in Bandra East 30k", "repeat_of_raw_message_id": None},
        {"id": 20, "message": "2 BHK sale Andheri 1.2 crore", "repeat_of_raw_message_id": None},
        {"id": 10, "message": "3 BHK for rent in Bandra East 30k", "repeat_of_raw_message_id": None},
    ]
    assert [row["id"] for row in _dedupe_raw_reposts(rows, {})] == [40, 20]


def test_dedupe_content_key_normalises_case_and_whitespace():
    rows = [
        {"id": 2, "message": "2   BHK   SALE  Andheri  1.2 crore"},
        {"id": 1, "message": "2 bhk sale andheri 1.2 crore"},
    ]
    assert [row["id"] for row in _dedupe_raw_reposts(rows, {})] == [2]


class _Response:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, rows):
        self._rows = rows
        self.offset_value = None
        self.limit_value = None
        self.filters = []

    def select(self, _columns):
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def ilike(self, _key, _value):
        return self

    def order(self, _key, desc=False):
        return self

    def offset(self, value):
        self.offset_value = value
        return self

    def limit(self, value):
        self.limit_value = value
        return self

    def execute(self):
        return _Response(self._rows)


class _Client:
    def __init__(self, rows):
        self._rows = rows
        self.query = None

    def table(self, name):
        assert name == "raw_messages"
        self.query = _Query(self._rows)
        return self.query


def _storage_with_rows(rows):
    storage = object.__new__(SupabaseStorage)
    storage._client = _Client(rows)
    return storage


ROWS = [
    {"id": 5, "message": "3 BHK rent in Bandra East 30k", "repeat_of_raw_message_id": None},
    {"id": 4, "message": "3 BHK rent in Bandra East 30k", "repeat_of_raw_message_id": 5},
    {"id": 3, "message": "We are hiring sales executive candidates, share your cv", "repeat_of_raw_message_id": None},
    {"id": 2, "message": "2 BHK sale Andheri 1.2 crore", "repeat_of_raw_message_id": None},
    {"id": 1, "message": "3 BHK rent in Bandra East 30k", "repeat_of_raw_message_id": 5},
]


def test_raw_group_page_dedupes_reposts_and_hides_spam():
    storage = _storage_with_rows(ROWS)
    page = storage.get_raw_group_messages_page(tenant_id="tenant-1", limit=10, offset=0)

    assert [item["id"] for item in page["items"]] == [5, 2]
    assert page["spam_hidden"] == 1
    assert page["deduped"] == 2
    assert page["next_source_offset"] == 5
    assert page["has_more"] is False


def test_raw_group_page_asks_the_database_for_deduped_rows():
    # Reposts are removed globally by the is_content_latest flag, so the feed
    # must filter on it rather than relying only on in-slab dedupe.
    storage = _storage_with_rows(ROWS)
    storage.get_raw_group_messages_page(tenant_id="tenant-1", limit=10, offset=0)
    emitted = {key for key, _ in storage._client.query.filters}
    assert "is_content_latest" in emitted


def test_raw_group_page_can_include_spam_and_advances_source_cursor():
    storage = _storage_with_rows(ROWS)
    page = storage.get_raw_group_messages_page(
        tenant_id="tenant-1", limit=10, offset=30, include_spam=True
    )

    assert [item["id"] for item in page["items"]] == [5, 3, 2]
    assert page["spam_hidden"] == 0
    # Cursor tracks the consumed source slab, not the deduped result length.
    assert page["next_source_offset"] == 35


def test_raw_group_page_respects_page_limit_without_losing_cursor():
    storage = _storage_with_rows(ROWS)
    page = storage.get_raw_group_messages_page(
        tenant_id="tenant-1", limit=1, offset=0, include_spam=True
    )

    assert [item["id"] for item in page["items"]] == [5]
    assert page["next_source_offset"] == 5
