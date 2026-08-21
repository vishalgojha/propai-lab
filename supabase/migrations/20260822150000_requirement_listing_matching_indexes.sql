create index if not exists idx_requirement_matches_tenant_score
  on public.requirement_matches (tenant_id, match_score desc, matched_at desc);

-- The unified sources are views. Their underlying typed tables already carry
-- the lookup indexes; indexing the views themselves is not valid PostgreSQL.
