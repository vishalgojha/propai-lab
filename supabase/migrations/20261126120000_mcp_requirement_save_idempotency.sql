-- Durable request-scoped idempotency for MCP requirement saves.
--
-- Scope: keyed saves only. This migration deliberately does NOT add any
-- uniqueness to clients or client_requirements: phone/name content
-- uniqueness would change existing CRM semantics for other writers and could
-- fail on real data, and content uniqueness must never collapse a save that
-- carries a new request key. Without a key, saves keep their existing
-- best-effort behavior in application code.
--
-- Mechanism: one atomic database function. The gate row in
-- mcp_save_requests and the CRM rows commit or roll back in the SAME
-- transaction, so a committed gate row always has its result ids and a
-- crashed save leaves no gate row at all. Concurrent saves with the same
-- key serialize on the unique index: the loser blocks until the winner
-- commits (then reads the winner's ids) or rolls back (then becomes the
-- winner). There is no release-and-retry path and no stale-state takeover.

create table if not exists public.mcp_save_requests (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.organizations(id) on delete cascade,
  save_request_key text not null,
  record_type text not null default 'buyer_requirement',
  request_fingerprint text not null,
  client_id bigint references public.clients(id) on delete set null,
  requirement_id bigint references public.client_requirements(id) on delete set null,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create unique index if not exists mcp_save_requests_tenant_key_key
  on public.mcp_save_requests (tenant_id, save_request_key);

alter table public.mcp_save_requests enable row level security;
revoke all on table public.mcp_save_requests from anon, authenticated, service_role;
grant select, insert, update, delete on table public.mcp_save_requests to service_role;
drop policy if exists mcp_save_requests_service_all on public.mcp_save_requests;
create policy mcp_save_requests_service_all on public.mcp_save_requests
  for all to service_role using (true) with check (true);

create or replace function public.mcp_save_requirement(
  p_tenant_id uuid,
  p_save_request_key text,
  p_name text,
  p_phone text,
  p_raw_text text,
  p_budget numeric,
  p_location text,
  p_bhk text
) returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_gate_id bigint;
  v_client_id bigint;
  v_requirement_id bigint;
  v_fingerprint text;
  v_phone text;
  v_digits text;
  v_existing record;
begin
  -- Same phone normalization as the application path: digits only; a 10-digit
  -- number gets +91, a 12-digit 91-prefixed number gets +; anything else is
  -- kept trimmed as given. Empty becomes null (no phone identity).
  v_digits := regexp_replace(coalesce(p_phone, ''), '[^0-9]', '', 'g');
  if v_digits = '' then
    v_phone := null;
  elsif length(v_digits) = 10 then
    v_phone := '+91' || v_digits;
  elsif length(v_digits) = 12 and v_digits like '91%' then
    v_phone := '+' || v_digits;
  else
    v_phone := nullif(btrim(p_phone), '');
  end if;

  v_fingerprint := md5(concat_ws(chr(31), coalesce(p_name, ''), coalesce(v_phone, ''), coalesce(p_raw_text, '')));

  -- Claim the request key. A concurrent save with the same key blocks here
  -- until this transaction commits or rolls back (unique-index speculative
  -- insertion), so exactly one request ever creates rows for a key.
  insert into public.mcp_save_requests (tenant_id, save_request_key, record_type, request_fingerprint)
  values (p_tenant_id, p_save_request_key, 'buyer_requirement', v_fingerprint)
  on conflict (tenant_id, save_request_key) do nothing
  returning id into v_gate_id;

  if v_gate_id is null then
    -- The key was already claimed and its transaction committed (a rollback
    -- would have removed the row and let our insert through). A committed
    -- gate row always carries its result ids.
    select g.client_id, g.requirement_id, g.request_fingerprint
      into v_existing
      from public.mcp_save_requests g
     where g.tenant_id = p_tenant_id and g.save_request_key = p_save_request_key;
    if not found or v_existing.requirement_id is null then
      raise exception 'requirement save for key "%" is in progress; retry the same request', p_save_request_key;
    end if;
    if v_existing.request_fingerprint is distinct from v_fingerprint then
      -- Same key but a different requirement: never silently collapse or
      -- overwrite; make the caller choose a new key.
      raise exception 'idempotency key "%" was already used for a different requirement; use a new key for a new save', p_save_request_key;
    end if;
    return jsonb_build_object('replayed', true, 'client_id', v_existing.client_id, 'requirement_id', v_existing.requirement_id);
  end if;

  -- A phone number identifies the client (identity, not content matching);
  -- without a phone every keyed save gets its own client row. Name is never
  -- used to reuse or merge clients.
  if v_phone is not null then
    select c.id into v_client_id
      from public.clients c
     where c.tenant_id = p_tenant_id and c.phone = v_phone
     order by c.updated_at desc
     limit 1;
  end if;

  if v_client_id is null then
    insert into public.clients (tenant_id, name, phone, notes, status, created_at, updated_at)
    values (p_tenant_id, nullif(btrim(p_name), ''), v_phone, p_raw_text, 'active', now(), now())
    returning id into v_client_id;
  end if;

  insert into public.client_requirements (tenant_id, client_id, intent, bhk, price_max, micro_market, notes, created_at, updated_at)
  values (p_tenant_id, v_client_id, 'requirement', p_bhk, p_budget, p_location, p_raw_text, now(), now())
  returning id into v_requirement_id;

  update public.mcp_save_requests
     set client_id = v_client_id, requirement_id = v_requirement_id, completed_at = now()
   where id = v_gate_id;

  return jsonb_build_object('replayed', false, 'client_id', v_client_id, 'requirement_id', v_requirement_id);
end;
$$;

revoke all on function public.mcp_save_requirement(uuid, text, text, text, text, numeric, text, text) from public, anon, authenticated;
grant execute on function public.mcp_save_requirement(uuid, text, text, text, text, numeric, text, text) to service_role;
