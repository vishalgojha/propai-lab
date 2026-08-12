-- Complete the existing Mumbai corridor order using canonical parent markets.
-- locality_reference stores many street/sub-locality labels in sub_locality,
-- while typed inventory is indexed by parent_locality/micro_market.
update public.locality_reference
set sort_order = case lower(trim(parent_locality))
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
