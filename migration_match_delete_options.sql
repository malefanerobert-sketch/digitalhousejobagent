-- View-local removal preserves original jobs and employer receipts for audit and duplicate protection.
ALTER TABLE public.job_matches ADD COLUMN IF NOT EXISTS admin_queue_deleted_at timestamptz;
ALTER TABLE public.job_matches ADD COLUMN IF NOT EXISTS user_applied_deleted_at timestamptz;
CREATE OR REPLACE FUNCTION public.protect_match_queue_deletion() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE privileged boolean;
BEGIN
 privileged:=current_user IN ('postgres','supabase_admin','service_role') OR coalesce(auth.role(),'')='service_role' OR EXISTS(SELECT 1 FROM public.dispatch_admins WHERE user_id=auth.uid());
 IF NOT privileged THEN
  IF (TG_OP='INSERT' AND NEW.admin_queue_deleted_at IS NOT NULL) OR (TG_OP='UPDATE' AND NEW.admin_queue_deleted_at IS DISTINCT FROM OLD.admin_queue_deleted_at) THEN RAISE EXCEPTION 'Only an admin can remove work from the admin queue'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_match_queue_deletion ON public.job_matches;
CREATE TRIGGER protect_match_queue_deletion BEFORE INSERT OR UPDATE ON public.job_matches FOR EACH ROW EXECUTE FUNCTION public.protect_match_queue_deletion();
CREATE OR REPLACE FUNCTION public.admin_delete_queue_match(p_match_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.job_matches;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.dispatch_admins WHERE user_id=auth.uid()) THEN RAISE EXCEPTION 'Admin access is required'; END IF;
 SELECT * INTO m FROM public.job_matches WHERE id=p_match_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Match not found'; END IF;
 UPDATE public.job_matches SET admin_queue_deleted_at=coalesce(admin_queue_deleted_at,now()) WHERE id=m.id;
 RETURN jsonb_build_object('id',m.id,'admin_queue_deleted',true);
END $$;
CREATE OR REPLACE FUNCTION public.user_delete_applied_match(p_match_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.job_matches;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
 SELECT jm.* INTO m FROM public.job_matches jm JOIN public.job_seekers s ON s.id=jm.job_seeker_id WHERE jm.id=p_match_id AND s.user_id=auth.uid() FOR UPDATE OF jm;
 IF NOT FOUND THEN RAISE EXCEPTION 'This is not your match'; END IF;
 IF m.status<>'applied' OR NOT EXISTS(SELECT 1 FROM public.application_log l WHERE l.job_match_id=m.id AND l.result='success' AND l.verification_status IN ('confirmed','admin_confirmed','user_confirmed')) THEN RAISE EXCEPTION 'This job has no completed application to remove'; END IF;
 UPDATE public.job_matches SET user_applied_deleted_at=coalesce(user_applied_deleted_at,now()) WHERE id=m.id;
 RETURN jsonb_build_object('id',m.id,'user_applied_deleted',true);
END $$;
REVOKE ALL ON FUNCTION public.protect_match_queue_deletion() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.admin_delete_queue_match(uuid),public.user_delete_applied_match(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_delete_queue_match(uuid),public.user_delete_applied_match(uuid) TO authenticated;

-- An explicit new applicant request reopens removed pending work.
CREATE OR REPLACE FUNCTION public.request_job_application(p_match_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.job_matches; s public.job_seekers;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
 SELECT * INTO m FROM public.job_matches WHERE id=p_match_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Match not found'; END IF;
 SELECT * INTO s FROM public.job_seekers WHERE id=m.job_seeker_id AND user_id=auth.uid();
 IF NOT FOUND THEN RAISE EXCEPTION 'This is not your match'; END IF;
 IF s.status<>'active' THEN RAISE EXCEPTION 'Your account is not active'; END IF;
 IF m.status='applied' THEN RAISE EXCEPTION 'This job is already applied'; END IF;
 IF m.status='submission_unverified' THEN RAISE EXCEPTION 'Admin must check the earlier uncertain submission before another application'; END IF;
 IF EXISTS(SELECT 1 FROM unnest(coalesce(s.blocked_companies,ARRAY[]::text[])) b WHERE lower(b)=lower(coalesce(m.company_name,'')))
 OR EXISTS(SELECT 1 FROM unnest(coalesce(s.blocked_locations,ARRAY[]::text[])) b WHERE b<>'' AND position(lower(b) in lower(coalesce(m.location,'')))>0)
 THEN RAISE EXCEPTION 'This company or location is blocked in your profile'; END IF;
 UPDATE public.job_matches SET status='approved',admin_queue_deleted_at=NULL,
  admin_application_requested_at=coalesce(admin_application_requested_at,now()) WHERE id=m.id;
 RETURN jsonb_build_object('id',m.id,'status','approved');
END $$;

