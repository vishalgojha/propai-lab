-- Durable WhatsApp conversation directory.
-- This is intentionally separate from market extraction: a WhatsApp group or
-- broadcast exists even when it has no property post, no parser result, or no
-- currently available history message.

create table if not exists public.whatsapp_conversations (
    id bigint generated always as identity primary key,
    tenant_id uuid not null references public.organizations(id) on delete cascade,
    broker_id text not null,
    instance text not null default '',
    conversation_jid text not null,
    conversation_type text not null check (conversation_type in ('group', 'broadcast', 'direct')),
    display_name text not null default '',
    unread_count integer not null default 0 check (unread_count >= 0),
    message_count integer not null default 0 check (message_count >= 0),
    last_message_at timestamptz,
    last_seen_at timestamptz not null default now(),
    source text not null default 'live',
    metadata jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    unique (tenant_id, broker_id, conversation_jid)
);

create index if not exists idx_whatsapp_conversations_directory
    on public.whatsapp_conversations (tenant_id, broker_id, conversation_type, last_message_at desc nulls last);

create index if not exists idx_whatsapp_conversations_jid
    on public.whatsapp_conversations (tenant_id, conversation_jid);

drop trigger if exists set_whatsapp_conversations_updated_at on public.whatsapp_conversations;
create trigger set_whatsapp_conversations_updated_at
before update on public.whatsapp_conversations
for each row execute function public.trigger_set_updated_at();

alter table public.whatsapp_conversations enable row level security;

drop policy if exists "organization members can read whatsapp conversations" on public.whatsapp_conversations;
create policy "organization members can read whatsapp conversations"
on public.whatsapp_conversations
for select to authenticated
using (
    exists (
        select 1
        from public.organization_members member
        where member.organization_id = whatsapp_conversations.tenant_id
          and member.user_id = (select auth.uid())
          and member.is_active = true
    )
);

-- Populate the directory from existing durable raw evidence. A future
-- GetJoinedGroups refresh adds silent groups too; this backfill preserves the
-- conversations that were already captured before the directory existed.
with raw_conversations as (
    select
        rm.tenant_id,
        coalesce(nullif(rm.raw_payload #>> '{data,broker_id}', ''), 'legacy') as broker_id,
        coalesce(nullif(rm.raw_payload #>> '{data,instance}', ''), '') as instance,
        conversation.jid as conversation_jid,
        case
            when conversation.jid like '%@g.us' then 'group'
            when conversation.jid like '%@broadcast' then 'broadcast'
            else 'direct'
        end as conversation_type,
        case
            when coalesce(rm.group_name, '') <> '' and rm.group_name <> conversation.jid then rm.group_name
            else coalesce(nullif(rm.raw_payload #>> '{data,conversationName}', ''), conversation.jid)
        end as display_name,
        case
            when rm.timestamp > now() + interval '7 days' then null
            else rm.timestamp
        end as timestamp
    from public.raw_messages rm
    cross join lateral (
        select coalesce(
            nullif(rm.raw_payload #>> '{data,key,remoteJid}', ''),
            nullif(rm.group_name, '')
        ) as jid
    ) conversation
    where rm.tenant_id is not null
      and conversation.jid <> ''
      and conversation.jid not in ('status@broadcast', 'broadcast')
      and conversation.jid not like '%@newsletter'
), collapsed as (
    select
        tenant_id, broker_id, conversation_jid,
        (array_agg(instance order by timestamp desc))[1] as instance,
        (array_agg(conversation_type order by timestamp desc))[1] as conversation_type,
        (array_agg(display_name order by timestamp desc))[1] as display_name,
        count(*)::integer as message_count,
        max(timestamp) as last_message_at
    from raw_conversations
    group by tenant_id, broker_id, conversation_jid
)
insert into public.whatsapp_conversations (
    tenant_id, broker_id, instance, conversation_jid, conversation_type,
    display_name, message_count, last_message_at, last_seen_at, source
)
select tenant_id, broker_id, instance, conversation_jid, conversation_type,
       display_name, message_count, last_message_at, now(), 'raw_backfill'
from collapsed
on conflict (tenant_id, broker_id, conversation_jid) do update
set message_count = greatest(
        public.whatsapp_conversations.message_count,
        excluded.message_count
    ),
    last_message_at = case
        when public.whatsapp_conversations.last_message_at is null then excluded.last_message_at
        when excluded.last_message_at is null then public.whatsapp_conversations.last_message_at
        else greatest(public.whatsapp_conversations.last_message_at, excluded.last_message_at)
    end,
    display_name = case
        when public.whatsapp_conversations.display_name = ''
          or public.whatsapp_conversations.display_name = public.whatsapp_conversations.conversation_jid
        then excluded.display_name
        else public.whatsapp_conversations.display_name
    end,
    last_seen_at = now();
