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


class _Response:
    def __init__(self, data):
        self.data = data


class _Query:
    def __init__(self, rows):
        self._rows = rows
        self.offset_value = None
        self.limit_value = None

    def select(self, _columns):
        return self

    def eq(self, _key, _value):
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
