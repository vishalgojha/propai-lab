CREATE TABLE IF NOT EXISTS llm_providers (
    id BIGINT PRIMARY KEY GENERATED ALWAYS AS IDENTITY,
    provider_name TEXT NOT NULL,
    provider_type TEXT NOT NULL DEFAULT 'openai',
    api_key TEXT NOT NULL DEFAULT '',
    base_url TEXT NOT NULL DEFAULT '',
    model_name TEXT NOT NULL DEFAULT '',
    is_active INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE llm_providers ENABLE ROW LEVEL SECURITY;

-- Allow full access via service_role
CREATE POLICY "service_role all" ON llm_providers
    FOR ALL TO service_role USING (true);

-- Allow authenticated read access
CREATE POLICY "authenticated select" ON llm_providers
    FOR SELECT TO authenticated USING (true);

-- Allow authenticated insert/update/delete
CREATE POLICY "authenticated all" ON llm_providers
    FOR ALL TO authenticated USING (true);
