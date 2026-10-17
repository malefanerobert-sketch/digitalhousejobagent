BEGIN;
DO $$
DECLARE blank_id uuid; ready_id uuid; match_id uuid; rejected boolean; constraint_name text; p public.job_seekers; key text;
BEGIN
 INSERT INTO public.job_seekers(full_name) VALUES('Discovery eligibility blank fixture') RETURNING id INTO blank_id;
 INSERT INTO public.job_seekers(full_name,date_of_birth,gender,id_type,id_number,nationality,phone,job_title_keywords,apply_qualifications,apply_experience_ranges)
 VALUES('Discovery eligibility ready fixture','1990-01-01','Other','passport','FIXTURE123','South African','0123456789',ARRAY['Finance Officer'],ARRAY['Diploma'],ARRAY['0-1']) RETURNING id INTO ready_id;
 SELECT * INTO p FROM public.job_seekers WHERE id=ready_id;
 IF NOT public.discovery_profile_ready(p) THEN RAISE EXCEPTION 'FAIL profile-only CV not accepted'; END IF;
 IF p.resume_url IS NOT NULL THEN RAISE EXCEPTION 'FAIL fixture unexpectedly has CV'; END IF;
 FOREACH key IN ARRAY ARRAY['full_name','date_of_birth','gender','id_type','id_number','nationality','phone','job_title_keywords','apply_qualifications','apply_experience_ranges'] LOOP
  IF public.discovery_profile_ready(jsonb_populate_record(p,jsonb_build_object(key,null))) THEN RAISE EXCEPTION 'FAIL missing field accepted: %',key; END IF;
 END LOOP;
 IF public.discovery_profile_ready(jsonb_populate_record(p,'{"job_title_keywords":["  ",null]}'::jsonb)) THEN RAISE EXCEPTION 'FAIL blank roles accepted'; END IF;
 rejected:=false;
 BEGIN
  INSERT INTO public.job_matches(job_seeker_id,job_title,job_url) VALUES(blank_id,'Synthetic blocked match','https://discovery-eligibility.invalid/blank');
 EXCEPTION WHEN check_violation THEN
  GET STACKED DIAGNOSTICS constraint_name=CONSTRAINT_NAME;
  IF constraint_name IS DISTINCT FROM 'job_matches_discovery_profile_ready' THEN RAISE; END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'FAIL database allowed blank signup'; END IF;
 INSERT INTO public.job_matches(job_seeker_id,job_title,job_url) VALUES(ready_id,'Synthetic allowed match','https://discovery-eligibility.invalid/ready') RETURNING id INTO match_id;
 -- Existing match history remains editable even if the profile is later cleared.
 UPDATE public.job_seekers SET phone=null WHERE id=ready_id;
 UPDATE public.job_matches SET job_title='Synthetic existing history retained' WHERE id=match_id;
 IF NOT EXISTS(SELECT 1 FROM public.job_matches WHERE id=match_id) THEN RAISE EXCEPTION 'FAIL existing history lost'; END IF;
 rejected:=false;
 BEGIN
  INSERT INTO public.job_matches(job_seeker_id,job_title,job_url) VALUES(ready_id,'Synthetic blocked after clearing','https://discovery-eligibility.invalid/cleared');
 EXCEPTION WHEN check_violation THEN
  GET STACKED DIAGNOSTICS constraint_name=CONSTRAINT_NAME;
  IF constraint_name IS DISTINCT FROM 'job_matches_discovery_profile_ready' THEN RAISE; END IF;
  rejected:=true;
 END;
 IF NOT rejected THEN RAISE EXCEPTION 'FAIL cleared profile still publishes'; END IF;
 IF has_function_privilege('anon','public.discovery_profile_ready(public.job_seekers)','EXECUTE') OR has_function_privilege('authenticated','public.discovery_profile_ready(public.job_seekers)','EXECUTE') THEN RAISE EXCEPTION 'FAIL unexpected public function grants'; END IF;
END $$;
ROLLBACK;
SELECT jsonb_build_object(
 'rolled_back_fixture_tests','PASS: blank signup blocked; completed profile without upload accepted; missing fields and blank roles blocked; cleared profile cannot publish; existing history preserved; no new public grants',
 'fixtures_remaining',(SELECT count(*) FROM public.job_seekers WHERE full_name IN ('Discovery eligibility blank fixture','Discovery eligibility ready fixture')),
 'live_profiles',(SELECT jsonb_agg(jsonb_build_object('id',s.id,'eligible',public.discovery_profile_ready(s),'matches',(SELECT count(*) FROM public.job_matches m WHERE m.job_seeker_id=s.id))) FROM public.job_seekers s),
 'trigger_enabled',(SELECT tgenabled='O' FROM pg_trigger WHERE tgname='guard_discovery_profile_eligibility' AND tgrelid='public.job_matches'::regclass),
 'match_rls_enabled',(SELECT relrowsecurity FROM pg_class WHERE oid='public.job_matches'::regclass),
 'migration',(SELECT version FROM supabase_migrations.schema_migrations WHERE name='discovery_profile_eligibility' ORDER BY version DESC LIMIT 1)
) AS verification;
