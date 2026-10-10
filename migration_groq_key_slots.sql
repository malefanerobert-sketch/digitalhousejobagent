-- Run once in Supabase SQL Editor BEFORE deploying the new admin/worker.
-- Existing dispatch_settings permissions are preserved, NOT broadened.
BEGIN;
ALTER TABLE public.dispatch_settings
  ADD COLUMN IF NOT EXISTS ai_api_keys jsonb NOT NULL DEFAULT '[null,null,null,null,null,null,null,null,null,null]'::jsonb,
  ADD COLUMN IF NOT EXISTS ai_key_cooldown_seconds integer NOT NULL DEFAULT 60;
-- Seed K1 from the existing shared Groq key without embedding any secret in this file.
UPDATE public.dispatch_settings
SET ai_api_keys = jsonb_build_array(ai_api_key,null,null,null,null,null,null,null,null,null)
WHERE ai_provider='groq' AND nullif(trim(ai_api_key),'') IS NOT NULL
  AND ai_api_keys = '[null,null,null,null,null,null,null,null,null,null]'::jsonb;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dispatch_settings_ai_keys_ten_slots' AND conrelid='public.dispatch_settings'::regclass) THEN
    ALTER TABLE public.dispatch_settings ADD CONSTRAINT dispatch_settings_ai_keys_ten_slots
    CHECK (jsonb_typeof(ai_api_keys)='array' AND jsonb_array_length(ai_api_keys)=10);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='dispatch_settings_ai_cooldown_range' AND conrelid='public.dispatch_settings'::regclass) THEN
    ALTER TABLE public.dispatch_settings ADD CONSTRAINT dispatch_settings_ai_cooldown_range
    CHECK (ai_key_cooldown_seconds BETWEEN 10 AND 600);
  END IF;
END $$;
COMMIT;
-- SECURITY: confirm dispatch_settings RLS/column grants do NOT expose ai_api_key
-- or ai_api_keys to anonymous visitors or ordinary users. Do not grant public read.
