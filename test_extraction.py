import json
import os
import sys
import traceback

sys.path.insert(0, "/app")
from extraction import process_raw_message
from storage.supabase import SupabaseStorage

url = os.getenv("SUPABASE_URL", "")
key = os.getenv("SUPABASE_SERVICE_KEY", "")
storage = SupabaseStorage(url, key)

# Override save_parsed to add debug output
from storage.supabase import SupabaseStorage
original_save_parsed = SupabaseStorage.save_parsed

def debug_save_parsed(self, parsed):
    print("DEBUG save_parsed called")
    data = {}
    for k, v in parsed.__dict__.items():
        if v is not None:
            print(f"  {k}: {type(v).__name__} = {repr(v)[:100]}")
            data[k] = v
    try:
        return original_save_parsed(self, parsed)
    except Exception as e:
        print(f"  ERROR: {e}")
        if hasattr(e, "response") and e.response is not None:
            try:
                print(f"  Response: {e.response.text}")
            except:
                pass
        raise

import storage.supabase
storage.supabase.SupabaseStorage.save_parsed = debug_save_parsed

url = os.getenv("SUPABASE_URL", "")
key = os.getenv("SUPABASE_SERVICE_KEY", "")
storage = SupabaseStorage(url, key)

rows = storage.db.execute('SELECT * FROM raw_messages WHERE processed = false ORDER BY id ASC LIMIT 10').fetchall()
print(f"Found {len(rows)} unprocessed messages")

for row in rows:
    row = dict(row)
    msg_id = row.get("id")
    group_name = row.get("group_name", "")[:50]
    print(f"Processing message {msg_id}: {group_name}")
    
    ctx = {
        "sender_name": row.get("sender"),
        "push_name": row.get("sender"),
        "sender_jid": row.get("sender_jid"),
        "sender_phone": row.get("sender_phone"),
        "group": row.get("group_name"),
        "group_name": row.get("group_name"),
        "msg_text": row.get("message"),
        "instance": "whatsapp",
        "is_dm": "g.us" not in (row.get("group_name") or ""),
        "message_uid": row.get("message_uid"),
        "message_id": row.get("id"),
        "msg": {"message": row.get("message")},
    }
    
    try:
        from extraction import process_raw_message
        process_raw_message(row["id"], ctx)
        print(f"  SUCCESS")
    except Exception as e:
        print(f"  ERROR: {e}")
        traceback.print_exc()