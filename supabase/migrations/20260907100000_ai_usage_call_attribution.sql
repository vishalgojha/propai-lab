-- Attribute extraction spend to the exact stage and retry that caused it.
-- Existing rows remain valid and are labelled as unknown for historical usage.

alter table public.ai_usage_log
  add column if not exists call_stage text not null default 'unknown',
  add column if not exists attempt_number integer,
  add column if not exists retry_reason text;

create index if not exists idx_ai_usage_log_source_stage
  on public.ai_usage_log (source_id, call_stage, created_at desc);

comment on column public.ai_usage_log.call_stage is
  'LLM call purpose: segmentation, initial_extraction, repair, chat, or another explicit stage.';
comment on column public.ai_usage_log.attempt_number is
  'One-based attempt number within the extraction call stage.';
comment on column public.ai_usage_log.retry_reason is
  'Bounded reason for a non-first attempt or repair call.';
