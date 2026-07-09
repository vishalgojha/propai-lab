
import sys
import os
from pathlib import Path

# Add project root to path
sys.path.insert(0, r"C:\propai lab")

# Load config
from config import SUPABASE_URL, SUPABASE_SERVICE_KEY
from storage.supabase import SupabaseStorage

storage = SupabaseStorage(SUPABASE_URL, SUPABASE_SERVICE_KEY)
storage.tenant_id = "00000000-0000-0000-0000-000000000010"

print(f"Testing with tenant_id: {storage.tenant_id}")

try:
    # Check total brokers
    count = storage.db.execute("SELECT COUNT(*) FROM brokers").fetchall()[0]
    print(f"Total brokers: {count}")

    # Check brokers with tenant_id
    count_tenant = storage.db.execute("SELECT COUNT(*) FROM brokers WHERE tenant_id = ?", (storage.tenant_id,)).fetchall()[0]
    print(f"Brokers with tenant_id {storage.tenant_id}: {count_tenant}")

    # Check brokers without tenant_id
    count_no_tenant = storage.db.execute("SELECT COUNT(*) FROM brokers WHERE tenant_id IS NULL OR tenant_id = ''").fetchall()[0]
    print(f"Brokers without tenant_id: {count_no_tenant}")
except Exception as e:
    print(f"Error: {e}")
