-- Expand the existing shared Groq vault without changing keys, model or grants.
-- Apply after migration_groq_key_slots.sql, before deploying the 20-slot UI.
DO $$
DECLARE
  previous public.dispatch_settings%ROWTYPE;
  current_settings public.dispatch_settings%ROWTYPE;
BEGIN
  SELECT * INTO previous FROM public.dispatch_settings FOR UPDATE;

  ALTER TABLE public.dispatch_settings
    DROP CONSTRAINT IF EXISTS dispatch_settings_ai_keys_ten_slots;
  ALTER TABLE public.dispatch_settings
    DROP CONSTRAINT IF EXISTS dispatch_settings_ai_keys_twenty_slots;

  UPDATE public.dispatch_settings
  SET ai_api_keys = ai_api_keys || '[null,null,null,null,null,null,null,null,null,null]'::jsonb
  WHERE jsonb_typeof(ai_api_keys) = 'array'
    AND jsonb_array_length(ai_api_keys) = 10;

  ALTER TABLE public.dispatch_settings
    ALTER COLUMN ai_api_keys SET DEFAULT
      '[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]'::jsonb;
  ALTER TABLE public.dispatch_settings
    ADD CONSTRAINT dispatch_settings_ai_keys_twenty_slots
    CHECK (jsonb_typeof(ai_api_keys) = 'array' AND jsonb_array_length(ai_api_keys) = 20);

  SELECT * INTO current_settings FROM public.dispatch_settings;
  IF previous.id IS NOT NULL THEN
    IF current_settings.ai_model IS DISTINCT FROM previous.ai_model
       OR current_settings.ai_provider IS DISTINCT FROM previous.ai_provider
       OR current_settings.ai_api_key IS DISTINCT FROM previous.ai_api_key THEN
      RAISE EXCEPTION 'Existing provider, model or legacy key changed';
    END IF;
    FOR i IN 0..jsonb_array_length(previous.ai_api_keys)-1 LOOP
      IF (current_settings.ai_api_keys -> i) IS DISTINCT FROM (previous.ai_api_keys -> i) THEN
        RAISE EXCEPTION 'An existing key slot changed';
      END IF;
    END LOOP;
  END IF;
END
$$;
-- Old cached 10-slot admin pages cannot save against the new exact-20 constraint:
-- refresh admin.html before editing. No RLS policies or permissions are changed.