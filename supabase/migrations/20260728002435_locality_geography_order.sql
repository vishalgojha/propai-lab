-- Ordered Mumbai locality references used for database-backed "between"
-- searches. The application never guesses intermediate localities; it reads
-- this persisted geography order.
alter table if exists public.locality_reference
  add column if not exists sort_order integer;

update public.locality_reference
set sort_order = case lower(sub_locality)
  when 'bkc' then 10
  when 'bandra east' then 20
  when 'bandra' then 25
  when 'bandra west' then 30
  when 'khar east' then 40
  when 'khar' then 45
  when 'khar west' then 50
  when 'santacruz east' then 60
  when 'santacruz' then 65
  when 'santacruz west' then 70
  when 'vile parle east' then 80
  when 'vile parle west' then 90
  when 'juhu' then 100
  when 'andheri east' then 110
  when 'andheri' then 115
  when 'andheri west' then 120
  when 'powai' then 130
  when 'goregaon east' then 140
  when 'goregaon west' then 150
  when 'malad east' then 160
  when 'malad west' then 170
  else sort_order
end
where sort_order is null;

create index if not exists idx_locality_reference_sort_order
  on public.locality_reference(sort_order);
