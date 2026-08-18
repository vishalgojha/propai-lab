-- WhatsApp/device labels can append a numeric suffix to an agency name.
-- Treat that suffix as transport noise for future name-only identity keys;
-- phone-backed identities remain authoritative and are not changed here.
create or replace function public.broker_identity_key(p_name text, p_phone text)
returns text
language plpgsql
stable
security invoker
set search_path = public, extensions
as $$
declare
    digits text;
    normalized_name text;
begin
    digits := regexp_replace(coalesce(p_phone, ''), '\D', '', 'g');
    if length(digits) >= 10 then
        return 'phone:' || right(digits, 10);
    end if;
    normalized_name := lower(regexp_replace(btrim(coalesce(p_name, '')), '\s*-\s*\d+\s*$', '', 'g'));
    normalized_name := regexp_replace(normalized_name, '\s+', ' ', 'g');
    if normalized_name <> '' then
        return 'name:' || normalized_name;
    end if;
    return null;
end;
$$;

comment on function public.broker_identity_key(text, text) is
  'Phone is authoritative; numeric WhatsApp/device suffixes are ignored for name-only broker identity.';
