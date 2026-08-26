-- Private CRM objects are never public.  The application normally accesses
-- this bucket with service_role; these policies also make the boundary
-- explicit if authenticated client access is introduced later.
drop policy if exists "private crm service role access" on storage.objects;
create policy "private crm service role access"
on storage.objects for all to service_role
using (bucket_id = 'private-crm')
with check (bucket_id = 'private-crm');

drop policy if exists "private crm authenticated tenant access" on storage.objects;
create policy "private crm authenticated tenant access"
on storage.objects for all to authenticated
using (
  bucket_id = 'private-crm'
  and (storage.foldername(name))[1] = coalesce(auth.jwt() ->> 'tenant_id', '')
)
with check (
  bucket_id = 'private-crm'
  and (storage.foldername(name))[1] = coalesce(auth.jwt() ->> 'tenant_id', '')
);
