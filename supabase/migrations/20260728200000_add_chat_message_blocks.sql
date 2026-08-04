ALTER TABLE ai_chat_messages ADD COLUMN IF NOT EXISTS blocks JSONB;

COMMENT ON COLUMN ai_chat_messages.blocks IS 'Structured response blocks (listing_cards, summary, etc.) persisted alongside text content for history reconstruction';
