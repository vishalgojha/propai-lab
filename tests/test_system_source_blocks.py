from extraction_worker import _remove_system_blocked_rows
from storage.supabase import SupabaseStorage


class _Storage:
    _source_block_key = staticmethod(SupabaseStorage._source_block_key)

    def __init__(self):
        self.suppressed = []

    def get_system_extraction_source_blocks(self):
        return [{"source_key": "gurukrupa", "display_name": "Gurukrupa", "aliases": ["gurukirpa"]}]

    def suppress_raw_message_for_system_block(self, raw_id, rule):
        self.suppressed.append((raw_id, rule["display_name"]))


def test_global_source_block_is_applied_before_extraction():
    storage = _Storage()
    rows = [("fast", 2, [
        {"id": 10, "message": "3 BHK, Gurukirpa Realtors", "sender": "", "group_name": "g"},
        {"id": 11, "message": "3 BHK, another broker", "sender": "", "group_name": "g"},
    ])]

    remaining, blocked = _remove_system_blocked_rows(storage, rows)

    assert blocked == 1
    assert storage.suppressed == [(10, "Gurukrupa")]
    assert [row["id"] for row in remaining[0][2]] == [11]


def test_source_block_key_only_folds_text_for_literal_matching():
    assert SupabaseStorage._source_block_key("Guru-Kirpa Realtors") == "gurukirparealtors"
