BEGIN;
DO $$
DECLARE sid uuid; uid uuid; mid uuid; r jsonb; blocked boolean; baseline_matches bigint; baseline_logs bigint;
BEGIN
 SELECT id,user_id INTO sid,uid FROM public.job_seekers WHERE user_id IS NOT NULL LIMIT 1;
 IF sid IS NULL THEN RAISE EXCEPTION 'No applicant available for rollback-only readiness test'; END IF;
 SELECT count(*) INTO baseline_matches FROM public.job_matches;
 SELECT count(*) INTO baseline_logs FROM public.application_log;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
 r:=public.get_application_readiness(sid);
 IF (r->>'ready')::boolean THEN RAISE EXCEPTION 'Existing unconfirmed applicant unexpectedly ready'; END IF;
 SELECT id INTO mid FROM public.job_matches WHERE job_seeker_id=sid AND status='pending' LIMIT 1;
 IF mid IS NOT NULL THEN
  blocked:=false;
  BEGIN PERFORM public.request_job_application(mid);
  EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'Awaiting applicant information:%' THEN blocked:=true; ELSE RAISE; END IF; END;
  IF NOT blocked THEN RAISE EXCEPTION 'Incomplete application queue request was not blocked'; END IF;
 END IF;
 -- Synthetic fixtures exist only inside this rolled-back transaction. No remote requests.
 UPDATE public.job_seekers SET full_name='Validation Applicant',dedicated_email='applicant@validation-only.local',phone='+27821234567',
 id_type='passport',id_number='P12345678',date_of_birth='1990-01-01',gender='Male',nationality='South African',right_to_work_sa=false,
 physical_address='1 Validation Road',city='Pretoria',province='Gauteng',postal_code='0002',notice_period_days=0,available_from=current_date,
 years_experience=1,current_employer='Validation Company',current_position='Data Capturer',highest_qualification='Matric / Grade 12',
 skills=ARRAY['Data entry'],languages=ARRAY['English'],job_title_keywords=ARRAY['Data Capturer'],preferred_locations=ARRAY['All locations'],
 apply_qualifications=ARRAY['Matric / Grade 12'],apply_experience_ranges=ARRAY['1-2 years'],resume_url=NULL,
 bio='Organised administrative professional experienced in accurate data entry and record keeping.',
 application_profile_confirmed_at=NULL,application_profile_confirmation_hash=NULL WHERE id=sid;
 DELETE FROM public.job_seeker_employment WHERE job_seeker_id=sid;
 DELETE FROM public.job_seeker_education WHERE job_seeker_id=sid;
 DELETE FROM public.job_seeker_references WHERE job_seeker_id=sid;
 DELETE FROM public.job_seeker_documents WHERE job_seeker_id=sid;
 INSERT INTO public.job_seeker_employment(job_seeker_id,company,position,start_date,is_current) VALUES(sid,'Validation Company','Data Capturer','2025-01-01',true);
 INSERT INTO public.job_seeker_education(job_seeker_id,institution,qualification,start_year,end_year) VALUES(sid,'Validation School','Matric',2006,2008);
 IF cardinality(public.application_readiness_errors(sid))<>0 THEN RAISE EXCEPTION 'Valid factual fixture rejected: %',array_to_string(public.application_readiness_errors(sid),'; '); END IF;
 r:=public.get_application_readiness(sid);
 IF (r->>'ready')::boolean THEN RAISE EXCEPTION 'Applicant confirmation missing but profile allowed'; END IF;
 r:=public.confirm_application_profile();
 IF NOT (r->>'ready')::boolean OR r->>'cv_mode'<>'profile_generated' THEN RAISE EXCEPTION 'Complete confirmed profile-generated CV fixture rejected'; END IF;
 UPDATE public.job_seekers SET phone='+27000000000' WHERE id=sid;
 r:=public.get_application_readiness(sid);
 IF (r->>'ready')::boolean OR (r->>'profile_confirmed')::boolean THEN RAISE EXCEPTION 'Changed profile retained readiness'; END IF;
 UPDATE public.job_seekers SET phone='+27821234567' WHERE id=sid;
 INSERT INTO public.job_seeker_documents(job_seeker_id,doc_type,file_name,file_url) VALUES(sid,'other','fixture.pdf','https://validation-only.local/fixture.pdf');
 IF (public.get_application_readiness(sid)->>'ready')::boolean THEN RAISE EXCEPTION 'Changed documents retained confirmation'; END IF;
 PERFORM public.confirm_application_profile();
 UPDATE public.job_seeker_employment SET start_date=NULL WHERE job_seeker_id=sid;
 IF (public.get_application_readiness(sid)->>'ready')::boolean THEN RAISE EXCEPTION 'Missing employment date was allowed'; END IF;
 UPDATE public.job_seeker_employment SET start_date='2025-01-01' WHERE job_seeker_id=sid;
 UPDATE public.job_seekers SET full_name='Demo Applicant' WHERE id=sid;
 IF cardinality(public.application_readiness_errors(sid))=0 THEN RAISE EXCEPTION 'Demo name accepted'; END IF;
 UPDATE public.job_seekers SET full_name='Validation Applicant' WHERE id=sid;
 blocked:=false;
 BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  UPDATE public.job_seekers SET application_profile_confirmed_at=now(),application_profile_confirmation_hash='forged' WHERE id=sid;
 EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'Use confirm_application_profile%' THEN blocked:=true; ELSE RAISE; END IF;
 END;
 EXECUTE 'RESET ROLE';
 IF NOT blocked THEN RAISE EXCEPTION 'Direct confirmation forgery was not blocked'; END IF;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated')::text,true);
 blocked:=false;
 BEGIN PERFORM public.get_application_readiness(sid);
 EXCEPTION WHEN raise_exception THEN IF SQLERRM LIKE 'Not authorised%' THEN blocked:=true; ELSE RAISE; END IF; END;
 IF NOT blocked THEN RAISE EXCEPTION 'Other applicant readiness was exposed'; END IF;
 IF public.valid_sa_identity_number('0000000000000') OR public.valid_sa_identity_number('123') THEN RAISE EXCEPTION 'Invalid identity format accepted'; END IF;
 IF baseline_matches<>(SELECT count(*) FROM public.job_matches) OR baseline_logs<>(SELECT count(*) FROM public.application_log) THEN RAISE EXCEPTION 'Readiness checks changed matches or application logs'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS readiness, generated CV path, missing dates, placeholder rejection, confirmation invalidation, owner-only access, protected confirmation and queue gate; all fixture writes rolled back' AS validation;
