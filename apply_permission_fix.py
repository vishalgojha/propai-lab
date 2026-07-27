#!/usr/bin/env python3
"""
Apply the remove_team_members permission fix to existing team members.

This script updates the permissions bitfield for team members with role='owner' or role='admin'
to include the new 'remove_team_members' permission (bit 7 = 128).

Usage:
  SUPABASE_URL="https://xxx.supabase.co" SUPABASE_SERVICE_KEY="xxx" python3 apply_permission_fix.py
"""

import os
import sys

# Add the project root to the path
sys.path.insert(0, "/home/vishal/Propai")

from storage.supabase import SupabaseStorage

SUPABASE_URL = os.getenv("SUPABASE_URL", "")
SUPABASE_SERVICE_KEY = os.getenv("SUPABASE_SERVICE_KEY", "")

if not SUPABASE_URL or not SUPABASE_SERVICE_KEY:
    print("Error: SUPABASE_URL and SUPABASE_SERVICE_KEY must be set")
    print("Usage: SUPABASE_URL='...' SUPABASE_SERVICE_KEY='...' python3 apply_permission_fix.py")
    sys.exit(1)

print("Connecting to Supabase...")
storage = SupabaseStorage(SUPABASE_URL, SUPABASE_SERVICE_KEY)

# First, check current state of team members
print("\nCurrent team members:")
members = storage.list_team_members()
for m in members:
    perm_keys = storage._perm_keys(m.get("permissions", 0))
    print(f"  ID: {m['id']}, Role: {m['role']}, Permissions: {perm_keys}")

# Apply the migration SQL
sql = """
UPDATE public.team_members
SET permissions = permissions | 128
WHERE role = 'owner'
  AND (permissions & 128) = 0;

UPDATE public.team_members
SET permissions = permissions | 128
WHERE role = 'admin'
  AND (permissions & 128) = 0;
"""

print("\nApplying migration...")
try:
    result = storage.db.execute(sql)
    print(f"Migration applied successfully")
    print(f"Affected rows: {result.rowcount}")
except Exception as e:
    print(f"Error applying migration: {e}")
    sys.exit(1)

# Verify the changes
print("\nAfter migration:")
members = storage.list_team_members()
for m in members:
    perm_keys = storage._perm_keys(m.get("permissions", 0))
    has_remove = "remove_team_members" in perm_keys
    print(f"  ID: {m['id']}, Role: {m['role']}, Permissions: {perm_keys}")
    print(f"    Has remove_team_members: {has_remove}")

print("\nDone!")