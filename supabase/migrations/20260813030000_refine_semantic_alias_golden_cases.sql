-- A broker alias must share identity evidence with the linked broker. Names
-- such as "Garden Facing" are property attributes, not broker aliases.
update public.semantic_retrieval_eval_cases
set active = false, updated_at = now()
where active and entity_type = 'broker_alias';

update public.semantic_retrieval_eval_cases c
set active = true,
    last_status = 'never_run', last_rank = null, last_similarity = null,
    last_error = null, last_model = null, last_run_at = null, updated_at = now()
from public.broker_aliases a
join public.brokers b on b.id = a.broker_id
where c.entity_type = 'broker_alias'
  and c.source_table = 'broker_aliases'
  and c.source_id = a.id
  and c.target_entity_type = 'broker'
  and c.target_source_table = 'brokers'
  and c.target_source_id = b.id
  and a.alias !~ '[0-9]'
  and a.alias ~ '[[:space:]]'
  and exists (
    select 1
    from regexp_split_to_table(lower(a.alias), '[^[:alnum:]]+') token
    where length(token) >= 3
      and lower(b.canonical_name) like '%' || token || '%'
  );
