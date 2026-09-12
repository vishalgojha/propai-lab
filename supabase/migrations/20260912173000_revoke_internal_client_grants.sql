-- Internal operational data is accessed through the API/workers with service_role.
-- Keep public listing views unchanged; remove accidental direct client-role grants
-- from raw messages, secrets, chat telemetry, queues, and webhook internals.
revoke all on table
  public.raw_messages,
  public.whatsmeow_message_secrets,
  public.ai_chat_messages,
  public.ai_chat_sessions,
  public.ai_usage_log,
  public.group_members,
  public.whatsapp_events,
  public.extraction_attempt_log,
  public.semantic_embedding_jobs,
  public.semantic_embeddings,
  public.whatsapp_webhook_outbox
from anon, authenticated;
