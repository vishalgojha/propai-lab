import { FastAPI, Request, HTTPException, Depends, Body } from "fastapi";
from typing import List, Optional
from pydantic import BaseModel
from storage.supabase import SupabaseStorage

class SuperAdminCreate(BaseModel):
    user_id: str
    phone: str = ""

class SuperAdminResponse(BaseModel):
    id: int
    user_id: str
    phone: str
    created_at: str

# These would be added to app.py
# For now, let me create the route handlers

async def list_super_admins(request: Request):
    storage: SupabaseStorage = request.app.state.storage
    admins = storage.list_super_admins()
    return {"admins": admins}

async def add_super_admin(request: Request, body: SuperAdminCreate):
    storage: SupabaseStorage = request.app.state.storage
    result = storage.add_super_admin(body.user_id, body.phone)
    if not result:
        raise HTTPException(400, "Failed to add super admin")
    return result

async def remove_super_admin(request: Request, user_id: str):
    storage: SupabaseStorage = request.app.state.storage
    ok = storage.remove_super_admin(user_id)
    if not ok:
        raise HTTPException(404, "Super admin not found")
    return {"ok": True}