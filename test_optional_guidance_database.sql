BEGIN;
DO $$
DECLARE sid uuid; uid uuid; mid uuid; v jsonb; rejected boolean:=false;
BEGIN
 SELECT s.id,s.user_id,m.id INTO sid,uid,mid FROM public.job_seekers s JOIN public.job_matches m ON m.job_seeker_id=s.id WHERE s.user_id IS NOT NULL AND s.status='active' AND m.status IN ('pending','skipped','failed') LIMIT 1;
 IF mid IS NULL THEN RAISE EXCEPTION 'No rollback-only queue fixture available'; END IF;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',uid,'role','authenticated')::text,true);
 UPDATE public.job_seekers SET city=NULL,bio=NULL,resume_url=NULL,application_profile_confirmed_at=NULL,application_profile_confirmation_hash=NULL,blocked_companies=ARRAY[]::text[],blocked_locations=ARRAY[]::text[] WHERE id=sid;
 v:=public.request_job_application(mid);
 IF v->>'status'<>'approved' THEN RAISE EXCEPTION 'Incomplete profile request rejected'; END IF;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated')::text,true);
 BEGIN PERFORM public.request_job_application(mid);
 EXCEPTION WHEN raise_exception THEN IF SQLERRM='This is not your match' THEN rejected:=true; ELSE RAISE; END IF; END;
 IF NOT rejected THEN RAISE EXCEPTION 'Ownership protection failed'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS incomplete/unconfirmed applicant can queue; ownership protection remains; all test updates rolled back' AS validation;
