-- HELD PROPOSAL — apply only with explicit approval (production DB change).
-- Defense-in-depth for broker_market_eligible_source_rows: today the view gates
-- on an active v2 consent row alone, while the non-property rule is enforced at
-- consent write time and in the live GET. This adds a name-hint predicate so a
-- row can never become readable through the pool while its group name matches
-- the non-property hints, mirroring broker_market_policy.py ordering exactly:
-- a property-pattern match wins over any non-property hint (property checked
-- first). Postgres POSIX word boundaries \m \M mirror Python \b here.
-- Regex word lists must stay in sync with broker_market_policy.py and
-- frontend/src/app/connections/page.tsx; tests/test_raw_source_view_guard_parity.py
-- enforces the parity against the live directory names.
begin;
set local lock_timeout = '2s';
set local statement_timeout = '10s';
create or replace view public.broker_market_eligible_source_rows as
 select r.id as raw_id,r.message as body,r.timestamp as posted_at,r.sender_phone,r.sender_jid
 from public.raw_messages r
 join public.org_whatsapp_connections c on c.organization_id=r.tenant_id
  and c.broker_id=split_part(r.event_id,':',1) and c.is_active is true
 join public.broker_market_raw_source_consents consent on consent.organization_id=r.tenant_id
  and consent.whatsapp_connection_id=c.id and consent.broker_id=c.broker_id
  and consent.group_jid=r.raw_payload #>> '{data,key,remoteJid}'
 where r.is_group is true and r.source='WHATSAPP' and r.pipeline_version='go-ingestor'
  and r.raw_payload #>> '{data,source}' is distinct from 'history_sync'
  and consent.group_jid ~ '^[0-9-]+@g\.us$'
  and split_part(r.message_uid,':',1)=c.broker_id
  and split_part(r.message_uid,':',2)=consent.group_jid
  and split_part(r.message_uid,':',3)<>''
  and r.event_id=c.broker_id||':'||split_part(r.message_uid,':',3)
  and r.message_uid=c.broker_id||':'||consent.group_jid||':'||split_part(r.message_uid,':',3)
  and not exists(select 1 from public.organization_group_connections privacy
   where privacy.organization_id=c.organization_id and privacy.whatsapp_connection_id=c.id
    and privacy.group_jid=consent.group_jid and privacy.opted_out is true)
  and consent.version='broker-property-cross-search-v2' and consent.revoked_at is null
  and not (
   consent.group_name ~* '\m(family|families|relatives|cousins?|friends?|personal|hare\s*krishna|bhajan|bhakti|kirtan|satsang|temple|mandir|church|mosque|prayer|katha|school|college|classmates?|students?|tuition|alumni|batchmates?|cricket|football|badminton|sports?|gaming|gamers?|good\s*morning|gm\s*(wishes|messages)|daily\s*wishes|festival\s*wishes|singles|socialise|socialising|socialize|socializing|jamming|music|catering|tiffin|healing|yoga|meditation)\M'
   and consent.group_name !~* '\m(real\s*estate|realty|realtors?|estates?|acres?|properties|property|builders?|broker(s|age)?|flats?|apartments?|housing|rera|rent(als?)?|lease|sale|commercial|residential|industrial|shops?|offices?|warehouses?|land|plots?|inventory|construction|development|bhk|homes)\M'
  )
  and r.synced_at>=consent.confirmed_at and r.timestamp>=consent.confirmed_at;
-- Existing search/get functions use this same view. ACLs are preserved by REPLACE.
commit;
