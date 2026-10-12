BEGIN;
DO $$
DECLARE seeker_id uuid; owner_id uuid; admin_id uuid; fixture_id uuid; denied boolean; first_date timestamptz; request_date timestamptz; r jsonb; total_logs bigint;
BEGIN
 SELECT id,user_id INTO seeker_id,owner_id FROM public.job_seekers WHERE status='active' AND user_id IS NOT NULL LIMIT 1;
 SELECT user_id INTO admin_id FROM public.dispatch_admins LIMIT 1;
 IF seeker_id IS NULL OR admin_id IS NULL THEN RAISE EXCEPTION 'Test requires existing seeker and admin'; END IF;
 INSERT INTO public.job_matches(job_seeker_id,job_title,company_name,job_url,location,status,skip_reason,discovered_at)
 VALUES(seeker_id,'LOCAL TEST — rolled back','Test fixture','https://example.invalid/rollback/'||gen_random_uuid(),'Fixture location','skipped','Fixture skip reason','2026-10-01T12:00:00Z') RETURNING id,discovered_at INTO fixture_id,first_date;
 PERFORM set_config('request.jwt.claim.sub',owner_id::text,true);
 PERFORM set_config('request.jwt.claim.role','authenticated',true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
 -- Fixture is deliberately not in a blocked company/location.
 r:=public.request_job_application(fixture_id);
 IF r->>'status'<>'approved' THEN RAISE EXCEPTION 'Queue test failed'; END IF;
 SELECT admin_application_requested_at INTO request_date FROM public.job_matches WHERE id=fixture_id;
 PERFORM public.request_job_application(fixture_id);
 IF NOT EXISTS(SELECT 1 FROM public.job_matches WHERE id=fixture_id AND discovered_at=first_date AND agent_skipped_at IS NOT NULL AND admin_application_requested_at=request_date) THEN RAISE EXCEPTION 'Discovery/skip preservation or request idempotence failed'; END IF;
 PERFORM set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('request.jwt.claim.sub'),'role','authenticated')::text,true);
 denied:=false;
 BEGIN PERFORM public.request_job_application(fixture_id); EXCEPTION WHEN others THEN denied:=position('not your match' in SQLERRM)>0; END;
 IF NOT denied THEN RAISE EXCEPTION 'Wrong-owner request was not blocked'; END IF;
 denied:=false;
 BEGIN PERFORM public.admin_record_application(fixture_id,'failed','Fixture failure'); EXCEPTION WHEN others THEN denied:=position('Admin access is required' in SQLERRM)>0; END;
 IF NOT denied THEN RAISE EXCEPTION 'Non-admin outcome was not blocked'; END IF;
 PERFORM set_config('request.jwt.claim.sub',admin_id::text,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
 denied:=false;
 BEGIN PERFORM public.admin_record_application(fixture_id,'success',NULL,'Fixture receipt','https://employer.example/receipt',NULL,false); EXCEPTION WHEN others THEN denied:=position('Confirm actual employer' in SQLERRM)>0; END;
 IF NOT denied THEN RAISE EXCEPTION 'Unchecked receipt was not blocked'; END IF;
 PERFORM public.admin_record_application(fixture_id,'failed','Fixture failure');
 IF NOT EXISTS(SELECT 1 FROM public.job_matches WHERE id=fixture_id AND status='failed' AND discovered_at=first_date) THEN RAISE EXCEPTION 'Failed outcome preservation test failed'; END IF;
 PERFORM public.admin_record_application(fixture_id,'success','Fixture ONLY, rollback','Fixture employer receipt',NULL,NULL,true);
 IF NOT EXISTS(SELECT 1 FROM public.job_matches WHERE id=fixture_id AND status='applied' AND discovered_at=first_date AND admin_applied_by=admin_id) THEN RAISE EXCEPTION 'Admin completion test failed'; END IF;
 IF NOT EXISTS(SELECT 1 FROM public.application_log WHERE job_match_id=fixture_id AND result='success' AND verification_status='admin_confirmed' AND recorded_by=admin_id) THEN RAISE EXCEPTION 'Admin attribution test failed'; END IF;
 SELECT count(*) INTO total_logs FROM public.application_log WHERE job_match_id=fixture_id;
 r:=public.admin_record_application(fixture_id,'success',NULL,NULL,NULL,NULL,false);
 IF r->>'already_recorded'<>'true' OR total_logs<>(SELECT count(*) FROM public.application_log WHERE job_match_id=fixture_id) THEN RAISE EXCEPTION 'Duplicate completion prevention test failed'; END IF;
 denied:=false;
 BEGIN UPDATE public.job_matches SET discovered_at=now() WHERE id=fixture_id; EXCEPTION WHEN others THEN denied:=position('original discovery date' in SQLERRM)>0; END;
 IF NOT denied THEN RAISE EXCEPTION 'Original discovery date was not protected'; END IF;
END $$;
ROLLBACK;
SELECT 'PASS: request ownership, admin permissions, receipt requirement, atomic outcomes, attribution, idempotence and date preservation. All fixtures rolled back.' AS test_result,
 (SELECT count(*) FROM public.job_matches) AS saved_matches_after,
 (SELECT count(*) FROM public.application_log) AS history_records_after;
