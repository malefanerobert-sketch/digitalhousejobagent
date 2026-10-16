-- Expand the shared Groq vault to 100 slots; preserve existing values and permissions.
-- Cached 20-slot admin pages must refresh before saving; short arrays are rejected,
-- not silently accepted, so they cannot erase newly configured K21-K100 values.
DO $$
DECLARE
  previous public.dispatch_settings%ROWTYPE;
  current_settings public.dispatch_settings%ROWTYPE;
  old_length integer;
BEGIN
  LOCK TABLE public.dispatch_settings IN ACCESS EXCLUSIVE MODE;
  SELECT * INTO previous FROM public.dispatch_settings WHERE id = true;
  IF previous.id IS NOT NULL THEN
    IF jsonb_typeof(previous.ai_api_keys) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'Expected a key-slot array';
    END IF;
    old_length := jsonb_array_length(previous.ai_api_keys);
    IF old_length > 100 THEN
      RAISE EXCEPTION 'Refusing to truncate existing key slots';
    END IF;
  END IF;
  ALTER TABLE public.dispatch_settings
    DROP CONSTRAINT IF EXISTS dispatch_settings_ai_keys_ten_slots,
    DROP CONSTRAINT IF EXISTS dispatch_settings_ai_keys_twenty_slots,
    DROP CONSTRAINT IF EXISTS dispatch_settings_ai_keys_hundred_slots;
  UPDATE public.dispatch_settings
    SET ai_api_keys = ai_api_keys || (
      SELECT coalesce(jsonb_agg(NULL::text), '[]'::jsonb)
      FROM generate_series(1, 100 - jsonb_array_length(ai_api_keys))
    )
    WHERE jsonb_array_length(ai_api_keys) < 100;
  ALTER TABLE public.dispatch_settings
    ALTER COLUMN ai_api_keys SET DEFAULT '[null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null,null]'::jsonb,
    ADD CONSTRAINT dispatch_settings_ai_keys_hundred_slots
    CHECK (jsonb_typeof(ai_api_keys) = 'array' AND jsonb_array_length(ai_api_keys) = 100);
  SELECT * INTO current_settings FROM public.dispatch_settings WHERE id = true;
  IF previous.id IS NOT NULL THEN
    IF (to_jsonb(current_settings) - 'ai_api_keys') IS DISTINCT FROM
       (to_jsonb(previous) - 'ai_api_keys') THEN
      RAISE EXCEPTION 'Unrelated settings changed';
    END IF;
    IF old_length > 0 THEN
      FOR i IN 0..old_length-1 LOOP
        IF (current_settings.ai_api_keys -> i) IS DISTINCT FROM (previous.ai_api_keys -> i) THEN
          RAISE EXCEPTION 'An existing key slot changed';
        END IF;
      END LOOP;
    END IF;
  END IF;
END
$$;
-- No policies, grants, provider/model values or existing keys are changed.
