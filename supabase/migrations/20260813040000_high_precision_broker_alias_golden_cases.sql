-- Keep only high-precision broker identity variants. The aliases table is
-- also populated from message text, so linked rows alone are not enough.
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
  and b.canonical_name !~ '[0-9@]'
  and lower(a.alias) !~* '(for more|contact|call|whatsapp|multiple options|regards|ready to move|configuration|negotiable|air conditioned|sea view|student|looking|rent|sale|available|family|bachelor|property type|juhu|andheri west|bandra west|garden facing|side by side|amenities|metro|inventory|washroom|toilet|pets|car park|brokerage|dear associates|only for|loan possible|position|pan mumbai|apartment|property)'
  and regexp_replace(lower(a.alias), '[^[:alnum:]]', '', 'g') <> regexp_replace(lower(b.canonical_name), '[^[:alnum:]]', '', 'g')
  and similarity(lower(a.alias), lower(b.canonical_name)) >= 0.35;
