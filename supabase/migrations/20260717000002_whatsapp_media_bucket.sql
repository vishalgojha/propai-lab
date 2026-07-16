INSERT INTO storage.buckets (id, name, public, file_size_limit)
VALUES ('whatsapp-media', 'whatsapp-media', false, 20971520)
ON CONFLICT (id) DO UPDATE
SET public = false, file_size_limit = EXCLUDED.file_size_limit;
