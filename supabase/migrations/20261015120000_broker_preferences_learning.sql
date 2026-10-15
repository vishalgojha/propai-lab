-- Broker preferences for self-chat learning
-- Stores per-broker search preferences learned from interactions

CREATE TABLE IF NOT EXISTS public.broker_preferences (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    broker_phone text NOT NULL,
    tenant_id uuid REFERENCES public.organizations(id),
    -- Search preferences learned from interactions
    preferred_localities jsonb DEFAULT '[]'::jsonb,
    preferred_bhk_ranges jsonb DEFAULT '[]'::jsonb,
    budget_min_lakh numeric,
    budget_max_lakh numeric,
    preferred_property_types jsonb DEFAULT '[]'::jsonb, -- residential/commercial
    preferred_transaction_types jsonb DEFAULT '[]'::jsonb, -- sale/rent
    preferred_furnishing jsonb DEFAULT '[]'::jsonb,
    -- Interaction tracking
    total_searches int DEFAULT 0,
    last_search_at timestamptz,
    last_active_at timestamptz,
    -- Behavior patterns
    prefers_raw_evidence boolean DEFAULT false,
    prefers_listings boolean DEFAULT true,
    prefers_requirements boolean DEFAULT false,
    -- Feedback signals
    viewed_listing_ids jsonb DEFAULT '[]'::jsonb,
    dismissed_listing_ids jsonb DEFAULT '[]'::jsonb,
    saved_listing_ids jsonb DEFAULT '[]'::jsonb,
    -- Metadata
    created_at timestamptz DEFAULT now(),
    updated_at timestamptz DEFAULT now(),
    UNIQUE (broker_phone, tenant_id)
);

CREATE INDEX IF NOT EXISTS idx_broker_preferences_tenant ON public.broker_preferences(tenant_id);
CREATE INDEX IF NOT EXISTS idx_broker_preferences_phone ON public.broker_preferences(broker_phone);

-- Updated_at trigger
CREATE TRIGGER set_broker_preferences_updated_at
    BEFORE UPDATE ON public.broker_preferences
    FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

-- RLS policies
ALTER TABLE public.broker_preferences ENABLE ROW LEVEL SECURITY;

CREATE POLICY "broker_preferences_tenant_isolation"
    ON public.broker_preferences
    FOR ALL
    USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
    WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

-- Service role bypass
CREATE POLICY "broker_preferences_service_role"
    ON public.broker_preferences
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);