-- Isolated developer-project crawl pipeline. This is deliberately separate
-- from WhatsApp evidence, typed extraction, and the offline evidence schema.
create table if not exists public.developer_projects (
  id bigint generated always as identity primary key,
  project_key text not null unique,
  canonical_name text not null,
  developer_name text,
  locality text,
  city text,
  slug text not null,
  building_id bigint references public.buildings(id) on delete set null,
  identity_status text not null default 'unlinked' check (identity_status in ('unlinked','linked','needs_review')),
  publication_status text not null default 'draft' check (publication_status in ('draft','published','noindex')),
  last_crawled_at timestamptz,
  last_fact_changed_at timestamptz,
  last_activity_changed_at timestamptz,
  next_crawl_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists developer_projects_public_slug_idx
  on public.developer_projects(locality, slug);

create table if not exists public.developer_project_sources (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.developer_projects(id) on delete cascade,
  source_url text not null,
  source_type text not null check (source_type in ('maharera','developer','portal')),
  priority integer not null default 100,
  enabled boolean not null default true,
  last_success_at timestamptz,
  last_error text,
  created_at timestamptz not null default now(),
  unique(project_id, source_url)
);

create table if not exists public.developer_project_crawl_runs (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.developer_projects(id) on delete cascade,
  source_id bigint references public.developer_project_sources(id) on delete set null,
  status text not null check (status in ('running','succeeded','failed','skipped')),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  http_status integer,
  content_hash text,
  facts_changed boolean not null default false,
  error text,
  metadata jsonb not null default '{}'
);

create table if not exists public.developer_project_source_documents (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.developer_projects(id) on delete cascade,
  source_id bigint references public.developer_project_sources(id) on delete set null,
  crawl_run_id bigint not null references public.developer_project_crawl_runs(id) on delete cascade,
  source_url text not null,
  page_title text,
  raw_text text not null,
  rendered_html text,
  content_hash text not null,
  crawled_at timestamptz not null default now(),
  unique(crawl_run_id)
);

create table if not exists public.developer_project_facts (
  id bigint generated always as identity primary key,
  project_id bigint not null references public.developer_projects(id) on delete cascade,
  fact_name text not null check (fact_name in ('project_name','developer','locality','address','bhk_range','price_range','amenities','possession_status','rera_number')),
  value_json jsonb not null,
  normalized_value text,
  first_seen_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  last_changed_at timestamptz not null default now(),
  unique(project_id, fact_name)
);

create table if not exists public.developer_project_fact_evidence (
  id bigint generated always as identity primary key,
  fact_id bigint not null references public.developer_project_facts(id) on delete cascade,
  document_id bigint not null references public.developer_project_source_documents(id) on delete cascade,
  evidence_text text not null,
  start_offset integer,
  end_offset integer,
  confidence numeric not null default 0,
  created_at timestamptz not null default now(),
  unique(fact_id, document_id, evidence_text)
);

create index if not exists developer_project_facts_project_idx on public.developer_project_facts(project_id);
create index if not exists developer_project_documents_project_idx on public.developer_project_source_documents(project_id, crawled_at desc);
create index if not exists developer_project_crawls_due_idx on public.developer_project_crawl_runs(project_id, started_at desc);

alter table public.developer_projects enable row level security;
alter table public.developer_project_sources enable row level security;
alter table public.developer_project_crawl_runs enable row level security;
alter table public.developer_project_source_documents enable row level security;
alter table public.developer_project_facts enable row level security;
alter table public.developer_project_fact_evidence enable row level security;

create policy developer_projects_public_read on public.developer_projects for select using (
  publication_status = 'published'
  and last_crawled_at is not null
  and last_crawled_at >= now() - interval '45 days'
);
create policy developer_project_sources_public_read on public.developer_project_sources for select using (
  exists (select 1 from public.developer_projects p where p.id = project_id and p.publication_status in ('published','noindex'))
);
create policy developer_project_facts_public_read on public.developer_project_facts for select using (
  exists (select 1 from public.developer_projects p where p.id = project_id and p.publication_status in ('published','noindex'))
);
create policy developer_project_documents_public_read on public.developer_project_source_documents for select using (
  exists (select 1 from public.developer_projects p where p.id = project_id and p.publication_status in ('published','noindex'))
);
create policy developer_project_evidence_public_read on public.developer_project_fact_evidence for select using (
  exists (
    select 1 from public.developer_project_facts f
    join public.developer_projects p on p.id = f.project_id
    where f.id = fact_id and p.publication_status in ('published','noindex')
  )
);

-- Crawl runs remain operationally private; the service role writes/reads them.
