-- WhatsApp history can contain malformed legacy timestamps. Never make an
-- impossible future timestamp the directory's latest activity.
update public.whatsapp_conversations
set last_message_at = null
where last_message_at > now() + interval '7 days';
