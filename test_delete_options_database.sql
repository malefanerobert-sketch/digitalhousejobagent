BEGIN;
DO $$
DECLARE admin_id uuid; owner_id uuid; mid uuid; sid uuid; r jsonb; original_date timestamptz; blocked boolean; n bigint; logs_before bigint; membership public.dispatch_admins;
BEGIN
 SELECT user_id INTO admin_id FROM public.dispatch_admins LIMIT 1;
 SELECT jm.id,jm.job_seeker_id,s.user_id,jm.discovered_at INTO mid,sid,owner_id,original_date FROM public.job_matches jm JOIN public.job_seekers s ON s.id=jm.job_seeker_id WHERE s.user_id=admin_id LIMIT 1;
 IF mid IS NULL THEN RAISE EXCEPTION 'No owned fixture for rollback-only test'; END IF;
 SELECT * INTO membership FROM public.dispatch_admins WHERE user_id=admin_id;
 -- Only one authenticated account exists. Simulate its non-admin role by removing membership inside this uncommitted transaction.
 DELETE FROM public.dispatch_admins WHERE user_id=admin_id;
 SELECT count(*) INTO n FROM public.job_matches;SELECT count(*) INTO logs_before FROM public.application_log;
 -- All fixture changes are inside this rolled-back transaction. No employer contacted.
 UPDATE public.job_seekers SET status='active',blocked_companies=ARRAY[]::text[],blocked_locations=ARRAY[]::text[] WHERE id=sid;
 UPDATE public.job_matches SET status='pending',admin_queue_deleted_at=NULL,user_applied_deleted_at=NULL WHERE id=mid;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
 blocked:=false;BEGIN PERFORM public.admin_delete_queue_match(mid);EXCEPTION WHEN raise_exception THEN IF SQLERRM='Admin access is required' THEN blocked:=true;ELSE RAISE;END IF;END;
 IF NOT blocked THEN RAISE EXCEPTION 'Applicant removed admin work';END IF;
 blocked:=false;BEGIN PERFORM public.user_delete_applied_match(mid);EXCEPTION WHEN raise_exception THEN IF SQLERRM='This job has no completed application to remove' THEN blocked:=true;ELSE RAISE;END IF;END;
 IF NOT blocked THEN RAISE EXCEPTION 'Pending job accepted as completed';END IF;
 INSERT INTO public.dispatch_admins SELECT (membership).*;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
 r:=public.admin_delete_queue_match(mid);
 IF (r->>'admin_queue_deleted')::boolean IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM public.job_matches WHERE id=mid AND admin_queue_deleted_at IS NOT NULL AND user_applied_deleted_at IS NULL AND discovered_at=original_date AND status='pending') THEN RAISE EXCEPTION 'Admin removal changed applicant record';END IF;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
 PERFORM public.request_job_application(mid);
 IF EXISTS(SELECT 1 FROM public.job_matches WHERE id=mid AND admin_queue_deleted_at IS NOT NULL) THEN RAISE EXCEPTION 'Explicit new request did not reopen admin queue';END IF;
 DELETE FROM public.dispatch_admins WHERE user_id=admin_id;
 blocked:=false;BEGIN EXECUTE 'SET LOCAL ROLE authenticated';UPDATE public.job_matches SET admin_queue_deleted_at=now() WHERE id=mid;EXCEPTION WHEN OTHERS THEN blocked:=true;END;EXECUTE 'RESET ROLE';
 IF NOT blocked THEN RAISE EXCEPTION 'Direct applicant admin-hide write allowed';END IF;
 INSERT INTO public.dispatch_admins SELECT (membership).*;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',admin_id,'role','authenticated')::text,true);
 PERFORM public.admin_record_application(mid,'success','ROLLBACK-ONLY fixture; no real employer receipt','ROLLBACK-ONLY synthetic receipt fixture','https://validation-only.invalid/receipt',NULL,true);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',gen_random_uuid(),'role','authenticated')::text,true);
 blocked:=false;BEGIN PERFORM public.user_delete_applied_match(mid);EXCEPTION WHEN raise_exception THEN IF SQLERRM='This is not your match' THEN blocked:=true;ELSE RAISE;END IF;END;
 IF NOT blocked THEN RAISE EXCEPTION 'Another applicant removed completed record';END IF;
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',owner_id,'role','authenticated')::text,true);
 DELETE FROM public.dispatch_admins WHERE user_id=admin_id;
 r:=public.user_delete_applied_match(mid);
 IF (r->>'user_applied_deleted')::boolean IS DISTINCT FROM true OR NOT EXISTS(SELECT 1 FROM public.job_matches WHERE id=mid AND user_applied_deleted_at IS NOT NULL AND status='applied' AND discovered_at=original_date) THEN RAISE EXCEPTION 'User removal changed completion status or discovery';END IF;
 PERFORM public.user_delete_applied_match(mid);
 IF n<>(SELECT count(*) FROM public.job_matches) OR logs_before+1<>(SELECT count(*) FROM public.application_log) THEN RAISE EXCEPTION 'Deletion unexpectedly erased jobs or receipts';END IF;
 IF has_function_privilege('anon','public.admin_delete_queue_match(uuid)','EXECUTE') OR has_function_privilege('anon','public.user_delete_applied_match(uuid)','EXECUTE') THEN RAISE EXCEPTION 'Anonymous deletion executable';END IF;
END $$;
ROLLBACK;
SELECT 'PASS admin-only queue removal; owner-only applied removal; direct queue hiding blocked; explicit requests reopen removed work; completed status/receipts/dates retained; all fixture changes rolled back' AS validation;
