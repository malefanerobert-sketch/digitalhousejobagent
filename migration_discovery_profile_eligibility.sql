-- No change to the profile form, optional CV uploads, wallets or existing matches.
-- Mirror its seven existing required fields and the existing qualification /
-- experience scope requirements. A target role is needed for personalised discovery.
CREATE OR REPLACE FUNCTION public.discovery_profile_ready(p_profile public.job_seekers)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog,public AS $$
 SELECT coalesce(
  p_profile.date_of_birth IS NOT NULL
  AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY[p_profile.full_name,p_profile.gender,p_profile.id_type,p_profile.id_number,p_profile.nationality,p_profile.phone]) value WHERE value IS NULL OR btrim(value)='')
  AND EXISTS (SELECT 1 FROM unnest(p_profile.job_title_keywords) value WHERE btrim(value)<>'')
  AND EXISTS (SELECT 1 FROM unnest(p_profile.apply_qualifications) value WHERE btrim(value)<>'')
  AND EXISTS (SELECT 1 FROM unnest(p_profile.apply_experience_ranges) value WHERE btrim(value)<>''),false);
$$;
REVOKE ALL ON FUNCTION public.discovery_profile_ready(public.job_seekers) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.discovery_profile_ready(public.job_seekers) TO service_role;

CREATE OR REPLACE FUNCTION public.guard_discovery_profile_eligibility()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE profile public.job_seekers;
BEGIN
 -- Share-lock prevents a profile from being cleared during match publication.
 SELECT * INTO profile FROM public.job_seekers WHERE id=NEW.job_seeker_id FOR SHARE;
 IF NOT FOUND OR NOT public.discovery_profile_ready(profile) THEN
  RAISE EXCEPTION 'Discovery is waiting for the existing required profile details and job preferences'
   USING ERRCODE='23514', CONSTRAINT='job_matches_discovery_profile_ready';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.guard_discovery_profile_eligibility() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER guard_discovery_profile_eligibility
 BEFORE INSERT ON public.job_matches
 FOR EACH ROW EXECUTE FUNCTION public.guard_discovery_profile_eligibility();
