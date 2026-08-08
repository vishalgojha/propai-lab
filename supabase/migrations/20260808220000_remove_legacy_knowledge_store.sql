-- The typed listing/requirement projections and raw_messages are the source
-- of truth. The old knowledge-record/trainer graph is no longer written or
-- read by the application, so remove it before tenant count makes ownership
-- and provenance ambiguous.
drop table if exists public.embeddings cascade;
drop table if exists public.knowledge_learning_candidates cascade;
drop table if exists public.knowledge_trainer cascade;
drop table if exists public.knowledge_observations cascade;
drop table if exists public.knowledge_aliases cascade;
drop table if exists public.knowledge_tags cascade;
drop table if exists public.knowledge_records cascade;
