-- ============================================================================
-- PropAI Phase 2 — Knowledge, Team, Companion, Enrichment, and remaining tables
-- ============================================================================

-- ── Knowledge & Learning ────────────────────────────────────────────────────

create table if not exists knowledge_records (
    id              bigint generated always as identity primary key,
    source_type     text not null,
    source_id       text,
    raw_content     text not null,
    processed_content text,
    sender_jid      text,
    sender_name     text,
    sender_phone    text,
    conversation_id text,
    conversation_name text,
    message_timestamp timestamptz not null,
    ingested_at     timestamptz not null default now(),
    content_type    text default 'unknown',
    intent          text,
    embedding_id    text,
    metadata        jsonb default '{}',
    confidence      numeric default 0.0,
    is_valid        boolean default true,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index idx_knowledge_records_source on knowledge_records(source_type, source_id);
create index idx_knowledge_records_conversation on knowledge_records(conversation_id);
create index idx_knowledge_records_created on knowledge_records(created_at desc);
create index idx_knowledge_records_fts on knowledge_records using gin (to_tsvector('english', raw_content));

create table if not exists knowledge_tags (
    id              bigint generated always as identity primary key,
    record_id       bigint not null references knowledge_records(id) on delete cascade,
    tag_type        text not null,
    tag_value       text not null,
    confidence      numeric default 1.0,
    source          text default 'system',
    created_at      timestamptz not null default now()
);

create index idx_knowledge_tags_record on knowledge_tags(record_id);
create index idx_knowledge_tags_type on knowledge_tags(tag_type, tag_value);

create table if not exists knowledge_aliases (
    id              bigint generated always as identity primary key,
    alias           text not null,
    canonical       text not null,
    entity_type     text not null,
    confidence      numeric default 1.0,
    source          text default 'system',
    locality        text default '',
    price_min       numeric default 0,
    price_max       numeric default 0,
    intel           jsonb default '{}',
    created_at      timestamptz not null default now(),
    unique(alias, entity_type)
);

create index idx_knowledge_aliases_canonical on knowledge_aliases(canonical);
create index idx_knowledge_aliases_entity on knowledge_aliases(entity_type);

create table if not exists knowledge_observations (
    id                  bigint generated always as identity primary key,
    entity_type         text not null,
    entity_name         text not null,
    observation_type    text not null,
    observation_text    text not null,
    confidence          integer not null default 1,
    observation_count   integer not null default 1,
    source_broker_name  text,
    source_broker_phone text,
    source_parsed_id    bigint,
    source_raw_id       bigint,
    created_at          timestamptz not null default now(),
    updated_at          timestamptz not null default now()
);

create index idx_knowledge_observations_entity on knowledge_observations(entity_type, entity_name);
create index idx_knowledge_observations_type on knowledge_observations(observation_type);

create table if not exists knowledge_trainer (
    id              bigint generated always as identity primary key,
    term            text not null unique,
    context         text default '',
    frequency       integer default 1,
    first_seen      timestamptz not null default now(),
    last_seen       timestamptz not null default now(),
    status          text default 'pending',
    resolved_by     text,
    resolved_at     timestamptz,
    raw_message_id  bigint,
    resolver_decision_id bigint,
    notes           text default '',
    created_at      timestamptz not null default now()
);

create index idx_knowledge_trainer_status on knowledge_trainer(status);
create index idx_knowledge_trainer_term on knowledge_trainer(term);

create table if not exists knowledge_learning_candidates (
    id              bigint generated always as identity primary key,
    phrase          text unique,
    frequency       integer default 1,
    first_seen      timestamptz default now(),
    last_seen       timestamptz default now(),
    confidence      numeric default 0.0,
    contexts        jsonb default '[]',
    raw_message_ids jsonb default '[]',
    source          text default 'scanner',
    status          text default 'candidate'
);

create index idx_knowledge_candidates_status on knowledge_learning_candidates(status);

create table if not exists learning_cards (
    id              bigint generated always as identity primary key,
    term            text not null,
    context         text default '',
    frequency       integer default 1,
    first_seen      timestamptz not null default now(),
    last_seen       timestamptz not null default now(),
    status          text default 'pending',
    resolved_type   text,
    resolved_value  text,
    resolved_by     text,
    resolved_at     timestamptz,
    created_at      timestamptz not null default now()
);

-- ── Embeddings ─────────────────────────────────────────────────────────────

create table if not exists embeddings (
    id              text primary key,
    record_id       bigint references knowledge_records(id) on delete cascade,
    model           text not null,
    embedding       public.vector(1536) not null,
    dimensions      integer not null,
    created_at      timestamptz not null default now()
);

create index idx_embeddings_record on embeddings(record_id);
create index idx_embeddings_model on embeddings(model);
create index idx_embeddings_vector on embeddings using ivfflat (embedding public.vector_cosine_ops) with (lists = 100);

-- ── AI & Suggestions ───────────────────────────────────────────────────────

create table if not exists ai_suggestions (
    id              bigint generated always as identity primary key,
    agent           text not null,
    suggestion_type text not null,
    title           text not null,
    description     text not null default '',
    source_data     jsonb default '{}',
    proposal_data   jsonb default '{}',
    confidence      numeric default 0.0,
    status          text not null default 'pending',
    rejection_reason text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create index idx_ai_suggestions_status on ai_suggestions(status);
create index idx_ai_suggestions_agent on ai_suggestions(agent);

create table if not exists ai_usage_log (
    id              bigint generated always as identity primary key,
    agent           text not null,
    model           text default 'gpt-4o-mini',
    tokens_input    integer default 0,
    tokens_output   integer default 0,
    cost_usd        numeric default 0.0,
    source          text default 'enrichment',
    source_id       bigint,
    created_at      timestamptz not null default now()
);

create index idx_ai_usage_log_created on ai_usage_log(created_at desc);
create index idx_ai_usage_log_agent on ai_usage_log(agent);

-- ── Alias Management ───────────────────────────────────────────────────────

create table if not exists alias_suggestions (
    id              bigint generated always as identity primary key,
    canonical       text not null,
    alias           text not null,
    confidence      numeric not null default 0.0,
    reasons         jsonb default '[]',
    source          text default 'auto_discovered',
    status          text default 'pending',
    reviewed_at     timestamptz,
    reviewed_by     text,
    created_at      timestamptz not null default now(),
    unique(canonical, alias)
);

create index idx_alias_suggestions_status on alias_suggestions(status);

create table if not exists broker_aliases_global (
    id              bigint generated always as identity primary key,
    alias           text not null unique,
    canonical       text not null,
    confidence      numeric default 0.0,
    source          text default 'ai',
    created_at      timestamptz not null default now()
);

create table if not exists building_aliases (
    id              bigint generated always as identity primary key,
    alias           text not null unique,
    canonical       text not null,
    confidence      numeric default 0.0,
    source          text default 'ai',
    created_at      timestamptz not null default now()
);

create table if not exists location_aliases (
    id              bigint generated always as identity primary key,
    alias           text not null unique,
    canonical       text not null,
    confidence      numeric default 0.0,
    source          text default 'ai',
    created_at      timestamptz not null default now()
);

-- ── Building Enrichment ────────────────────────────────────────────────────

create table if not exists building_enrichment_jobs (
    id              bigint generated always as identity primary key,
    building_id     bigint references buildings(id) on delete cascade,
    status          text not null default 'pending',
    provider        text not null,
    priority        integer default 0,
    attempts        integer default 0,
    max_attempts    integer default 3,
    last_error      text,
    scheduled_after timestamptz not null default now(),
    started_at      timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz not null default now()
);

create index idx_enrichment_jobs_status on building_enrichment_jobs(status);
create index idx_enrichment_jobs_building on building_enrichment_jobs(building_id);

create table if not exists building_enrichment_history (
    id              bigint generated always as identity primary key,
    building_id     bigint references buildings(id) on delete cascade,
    job_id          bigint references building_enrichment_jobs(id) on delete set null,
    provider        text not null,
    action          text not null,
    fields_updated  jsonb default '[]',
    confidence      numeric default 0.0,
    details         jsonb default '{}',
    created_at      timestamptz not null default now()
);

create index idx_enrichment_history_building on building_enrichment_history(building_id);

create table if not exists building_enrichment_sources (
    id              bigint generated always as identity primary key,
    building_id     bigint references buildings(id) on delete cascade,
    provider        text not null,
    field_name      text not null,
    field_value     text,
    confidence      numeric default 0.0,
    source_url      text,
    source_record_id text,
    enriched_at     timestamptz not null default now(),
    unique(building_id, provider, field_name)
);

create table if not exists enrichment_jobs (
    id              bigint generated always as identity primary key,
    parsed_id       bigint not null references parsed_output(id),
    raw_message_id  bigint not null references raw_messages(id),
    status          text not null default 'pending',
    scheduled_after timestamptz not null,
    attempts        integer not null default 0,
    last_error      text,
    started_at      timestamptz,
    completed_at    timestamptz,
    created_at      timestamptz not null default now(),
    unique(parsed_id)
);

-- ── Requrement Matching ────────────────────────────────────────────────────

create table if not exists requirement_matches (
    id              bigint generated always as identity primary key,
    requirement_id  bigint not null references parsed_output(id) on delete cascade,
    listing_id      bigint not null references listings(id) on delete cascade,
    match_score     numeric not null default 0.0,
    bhk_match       boolean default false,
    market_match    boolean default false,
    price_match     numeric default 0.0,
    building_match  boolean default false,
    intent_match    boolean default false,
    matched_at      timestamptz not null default now(),
    unique(requirement_id, listing_id)
);

-- ── Observations ───────────────────────────────────────────────────────────

create table if not exists observations (
    id              bigint generated always as identity primary key,
    fingerprint     text not null,
    broker_key      text not null,
    summary_title   text default '',
    intent          text,
    bhk             text,
    price           numeric,
    price_unit      text,
    building_name   text,
    micro_market    text,
    location_raw    text,
    first_seen      timestamptz,
    last_seen       timestamptz,
    times_seen      integer default 1,
    created_at      timestamptz default now(),
    unique(broker_key, fingerprint)
);

create table if not exists observation_evidence (
    id              bigint generated always as identity primary key,
    observation_id  bigint not null references observations(id),
    raw_message_id  bigint not null references raw_messages(id),
    parsed_id       bigint not null references parsed_output(id),
    evidence_type   text default 'group',
    source_conversation text default '',
    seen_at         timestamptz,
    created_at      timestamptz default now(),
    unique(observation_id, raw_message_id)
);

create table if not exists observation_batches (
    id              bigint generated always as identity primary key,
    batch_type      text not null default 'observation_extraction',
    batch_api_id    text,
    status          text not null default 'created',
    total_requests  integer not null default 0,
    completed_count integer not null default 0,
    failed_count    integer not null default 0,
    input_file_id   text,
    output_file_id  text,
    input_path      text,
    error_message   text,
    stats_snapshot  jsonb,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

-- ── Resolution ─────────────────────────────────────────────────────────────

create table if not exists resolver_decisions (
    id              bigint generated always as identity primary key,
    parsed_id       bigint not null references parsed_output(id),
    building_id     bigint,
    building_name   text,
    landmark_id     text,
    landmark_name   text,
    street_id       text,
    street_name     text,
    project_id      bigint,
    project_name    text,
    developer_name  text,
    parser_confidence   numeric default 0.0,
    resolver_confidence numeric default 0.0,
    final_confidence    numeric default 0.0,
    method          text default 'unresolved',
    method_detail   text,
    candidates      jsonb default '[]',
    failure_category text,
    error           text,
    event_id        text,
    created_at      timestamptz not null default now()
);

create index idx_resolver_decisions_parsed on resolver_decisions(parsed_id);
create index idx_resolver_decisions_method on resolver_decisions(method);

-- ── Price Stats ────────────────────────────────────────────────────────────

create table if not exists price_stats (
    id              bigint generated always as identity primary key,
    micro_market    text not null,
    bhk             text not null,
    intent          text not null default 'listing',
    median          numeric,
    mean            numeric,
    p5              numeric,
    p25             numeric,
    p75             numeric,
    p95             numeric,
    count           integer not null default 0,
    computed_at     timestamptz not null default now(),
    unique(micro_market, bhk, intent)
);

create table if not exists price_unit_aliases (
    id              bigint generated always as identity primary key,
    alias           text not null unique,
    canonical_unit  text not null,
    created_at      timestamptz default now()
);

-- ── Team & Members ─────────────────────────────────────────────────────────

create table if not exists team_members (
    id              bigint generated always as identity primary key,
    name            text not null,
    email           text unique default '',
    phone           text default '',
    role            text not null default 'member',
    permissions     integer not null default 0,
    is_active       boolean not null default true,
    linked_broker_phone text,
    created_at      timestamptz default now(),
    updated_at      timestamptz default now()
);

create table if not exists team_member_whatsapp_access (
    id              bigint generated always as identity primary key,
    team_member_id  bigint not null references team_members(id),
    whatsapp_number text not null,
    can_send        boolean not null default false,
    can_view_messages boolean not null default true,
    created_at      timestamptz default now(),
    unique(team_member_id, whatsapp_number)
);

create table if not exists activity_log (
    id              bigint generated always as identity primary key,
    team_member_id  integer not null references team_members(id),
    action          text not null,
    target_type     text default '',
    target_id       text default '',
    details         jsonb default '{}',
    ip_address      text default '',
    created_at      timestamptz default now()
);

create table if not exists chat_assignments (
    id              bigint generated always as identity primary key,
    whatsapp_number text not null,
    remote_jid      text not null,
    assigned_to     bigint references team_members(id),
    taken_over_by   bigint references team_members(id),
    taken_over_at   timestamptz,
    released_at     timestamptz,
    created_at      timestamptz default now(),
    unique(whatsapp_number, remote_jid)
);

-- ── Follow-ups ─────────────────────────────────────────────────────────────

create table if not exists follow_ups (
    id              bigint generated always as identity primary key,
    client_id       bigint references clients(id) on delete set null,
    message_id      bigint references raw_messages(id) on delete set null,
    building_name   text,
    broker_phone    text,
    follow_up_type  text not null,
    title           text not null,
    notes           text default '',
    due_date        date not null,
    due_time        time,
    status          text default 'pending',
    created_at      timestamptz default now()
);

-- ── Companion ──────────────────────────────────────────────────────────────

create table if not exists companion_config (
    key             text primary key,
    value           text not null default '',
    updated_at      timestamptz not null default now()
);

create table if not exists companion_team_members (
    id              bigint generated always as identity primary key,
    name            text not null,
    mobile_number   text not null unique,
    role            text not null default 'sales_agent',
    assigned_markets jsonb default '[]',
    active          boolean not null default true,
    waba_identity   text default '',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table if not exists companion_audit_log (
    id              bigint generated always as identity primary key,
    team_member_id  bigint references companion_team_members(id) on delete set null,
    action          text not null,
    target_type     text default '',
    target_id       text default '',
    status          text not null default 'logged',
    details         jsonb default '{}',
    created_at      timestamptz not null default now()
);

create table if not exists companion_conversations (
    id              bigint generated always as identity primary key,
    team_member_id  bigint references companion_team_members(id) on delete set null,
    mobile_number   text not null,
    status          text not null default 'ai_active',
    context         jsonb default '{}',
    last_message_at timestamptz,
    pending_reason  text default '',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table if not exists companion_messages (
    id              bigint generated always as identity primary key,
    conversation_id bigint references companion_conversations(id) on delete cascade,
    direction       text not null,
    message         text not null default '',
    intent          text default '',
    status          text not null default 'received',
    created_at      timestamptz not null default now()
);

-- ── JID Profiles ───────────────────────────────────────────────────────────

create table if not exists jid_profiles (
    id              bigint generated always as identity primary key,
    jid_key         text not null unique,
    jid             text default '',
    phone           text default '',
    display_name    text default '',
    message_count   integer not null default 0,
    group_count     integer not null default 0,
    listing_count   integer not null default 0,
    requirement_count integer not null default 0,
    residential_count integer not null default 0,
    commercial_count integer not null default 0,
    sale_count      integer not null default 0,
    rental_count    integer not null default 0,
    first_seen_at   timestamptz,
    last_seen_at    timestamptz,
    last_message_id bigint references raw_messages(id),
    top_localities  jsonb default '[]',
    top_buildings   jsonb default '[]',
    top_groups      jsonb default '[]',
    profile_json    jsonb default '{}',
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table if not exists jid_aliases (
    id              bigint generated always as identity primary key,
    jid_key         text not null references jid_profiles(jid_key) on delete cascade,
    alias           text not null,
    observation_count integer not null default 0,
    first_seen_at   timestamptz,
    last_seen_at    timestamptz,
    unique(jid_key, alias)
);

create table if not exists jid_message_index (
    id              bigint generated always as identity primary key,
    jid_key         text not null references jid_profiles(jid_key) on delete cascade,
    raw_message_id  bigint not null references raw_messages(id) on delete cascade,
    group_name      text default '',
    timestamp       timestamptz,
    message_kind    text,
    residential_commercial text,
    transaction_type text,
    bhk             text,
    budget          numeric,
    budget_unit     text,
    locality        text,
    building_name   text,
    confidence      numeric default 0.0,
    metadata_json   jsonb default '{}',
    unique(jid_key, raw_message_id)
);

-- ── Sync, Checkpoints & Conversation Index ─────────────────────────────────

create table if not exists source_sync_jobs (
    id              bigint generated always as identity primary key,
    source          text not null,
    instance        text not null default '',
    group_id        text not null,
    group_name      text default '',
    meta            jsonb default '{}',
    status          text default 'pending',
    records_found   integer default 0,
    records_processed integer default 0,
    records_failed  integer default 0,
    last_cursor     text,
    error           text,
    started_at      timestamptz,
    finished_at     timestamptz,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table if not exists sync_checkpoints (
    id              bigint generated always as identity primary key,
    instance_name   text not null,
    group_jid       text not null,
    group_name      text default '',
    group_owner     text default '',
    participants    integer default 0,
    last_message_id text,
    last_message_ts timestamptz,
    first_message_ts timestamptz,
    last_synced_ts  timestamptz,
    total_available integer default 0,
    synced_count    integer default 0,
    status          text default 'pending',
    error           text,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now(),
    unique(instance_name, group_jid)
);

create table if not exists conversation_index (
    id              bigint generated always as identity primary key,
    conversation_id text not null,
    conversation_name text,
    message_count   integer default 0,
    participant_count integer default 0,
    first_message   timestamptz,
    last_message    timestamptz,
    last_activity   timestamptz,
    metadata        jsonb default '{}',
    unique(conversation_id)
);

-- ── Evaluations ────────────────────────────────────────────────────────────

create table if not exists evaluations (
    id              bigint generated always as identity primary key,
    raw_message_id  integer not null references raw_messages(id),
    event_id        text,
    expected_intent         text,
    expected_principal      text,
    expected_message_type   text,
    expected_bhk            text,
    expected_price          numeric,
    expected_price_unit     text,
    expected_area_sqft      numeric,
    expected_furnishing     text,
    expected_building       text,
    expected_landmark       text,
    expected_street         text,
    expected_area           text,
    expected_micro_market   text,
    expected_developer      text,
    expected_broker         text,
    extracted_intent        text,
    extracted_principal     text,
    extracted_message_type  text,
    extracted_bhk           text,
    extracted_price         numeric,
    extracted_price_unit    text,
    extracted_area_sqft     numeric,
    extracted_furnishing    text,
    extracted_building      text,
    extracted_landmark      text,
    extracted_street        text,
    extracted_area          text,
    extracted_micro_market  text,
    extracted_developer     text,
    extracted_broker        text,
    accuracy_overall    numeric,
    correction_notes    text,
    evaluated_at        timestamptz,
    created_at          timestamptz not null default now()
);

-- ── Listing Photos ─────────────────────────────────────────────────────────

create table if not exists listing_photos (
    id              bigint generated always as identity primary key,
    listing_id      bigint not null references listings(id),
    pic_token       text not null,
    media_id        text default '',
    filename        text not null,
    filepath        text not null,
    mime_type       text default 'image/jpeg',
    caption         text default '',
    sender_phone    text default '',
    sender_name     text default '',
    created_at      timestamptz default now()
);

-- ── Misc ───────────────────────────────────────────────────────────────────

create table if not exists saved_inbox_views (
    id              bigint generated always as identity primary key,
    slug            text not null unique,
    name            text not null,
    description     text default '',
    filters         jsonb not null default '{}',
    is_default      boolean not null default false,
    is_shared       boolean not null default false,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);

create table if not exists combined_locality_rules (
    id              bigint generated always as identity primary key,
    surface         text not null unique,
    expands_to      text not null,
    created_at      timestamptz default now()
);