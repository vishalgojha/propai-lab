-- Make automatic workspace provisioning retry-safe and remove only the two
-- confirmed empty retry-loop duplicate groups.

alter table public.organizations
  add column if not exists owner_user_id uuid references auth.users(id) on delete set null,
  add column if not exists owner_phone text;

alter table public.organizations
  drop constraint if exists organizations_owner_user_id_key,
  add constraint organizations_owner_user_id_key unique (owner_user_id);

alter table public.organizations
  drop constraint if exists organizations_owner_phone_key,
  add constraint organizations_owner_phone_key unique (owner_phone);

-- Refuse to delete a duplicate if any public table carrying a tenant or
-- organization reference contains data for it. This includes raw messages,
-- typed listings/requirements, memberships, connections, and future tenant
-- tables added with the standard column names.
do $$
declare
  candidate record;
  ref_col record;
  has_reference boolean;
begin
  for candidate in
    select id, name, created_at,
           row_number() over (
             partition by lower(trim(name))
             order by created_at asc, id asc
           ) as rn
      from public.organizations
     where lower(trim(name)) in ('sunil.mukhia', 'anantarealty50')
  loop
    if candidate.rn = 1 then
      continue;
    end if;

    if exists (
      select 1 from public.organization_members
       where organization_id = candidate.id
    ) then
      raise exception 'Refusing duplicate organization delete: % has members', candidate.id;
    end if;

    for ref_col in
      select table_name, column_name
        from information_schema.columns
       where table_schema = 'public'
         and table_name <> 'organizations'
         and column_name in ('tenant_id', 'organization_id')
    loop
      execute format(
        'select exists (select 1 from public.%I where %I = $1)',
        ref_col.table_name, ref_col.column_name
      ) into has_reference using candidate.id;
      if has_reference then
        raise exception 'Refusing duplicate organization delete: %.% references %',
          ref_col.table_name, ref_col.column_name, candidate.id;
      end if;
    end loop;

    delete from public.organizations where id = candidate.id;
  end loop;
end $$;

-- Verify the cleanup target is now one canonical organization per name.
do $$
begin
  if exists (
    select 1
      from public.organizations
     where lower(trim(name)) in ('sunil.mukhia', 'anantarealty50')
     group by lower(trim(name))
    having count(*) > 1
  ) then
    raise exception 'Duplicate organization cleanup did not converge';
  end if;
end $$;
