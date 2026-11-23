"""Private WhatsApp DMs must not enter the source-evidence queue."""

import pytest

from storage.supabase import SupabaseStorage


def test_storage_rejects_direct_whatsapp_raw_message():
    storage = object.__new__(SupabaseStorage)
    storage._tenant_id = "tenant-1"
    message = type("Raw", (), {
        "__dict__": {
            "tenant_id": "tenant-1",
            "source": "WHATSAPP",
            "is_group": False,
            "message": "private broker DM",
        }
    })()

    with pytest.raises(ValueError, match="direct-message ingestion disabled"):
        storage.save_raw_message(message)
