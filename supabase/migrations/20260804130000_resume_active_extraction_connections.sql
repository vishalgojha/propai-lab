-- The extraction controls migration initialized every existing connection to
-- `stopped` so the UI could introduce the new control safely.  Those existing
-- connections were already active before the control existed, so leaving them
-- stopped strands their queued raw messages and makes the worker report that
-- every tenant is paused.
--
-- Resume only active connections that still have the migration's initial
-- stopped state.  Explicit pause/stop actions remain authoritative after this
-- one-time recovery, and inactive connections remain stopped.
update public.org_whatsapp_connections
set extraction_status = 'running',
    updated_at = now()
where is_active = true
  and extraction_status = 'stopped';

notify pgrst, 'reload schema';
