-- Permanent discovery records + authenticated admin-owned application outcomes.
ALTER TABLE public.job_matches
 ADD COLUMN IF NOT EXISTS agent_skipped_at timestamptz,
 ADD COLUMN IF NOT EXISTS admin_application_requested_at timestamptz,
 ADD COLUMN IF NOT EXISTS admin_applied_at timestamptz,
 ADD COLUMN IF NOT EXISTS admin_applied_by uuid;
ALTER TABLE public.application_log ADD COLUMN IF NOT EXISTS recorded_by uuid;
UPDATE public.job_matches SET agent_skipped_at=coalesce(decided_at,discovered_at,now())
 WHERE agent_skipped_at IS NULL AND (status='skipped' OR nullif(trim(skip_reason),'') IS NOT NULL);
ALTER TABLE public.application_log DROP CONSTRAINT IF EXISTS application_log_verification_status_check;
ALTER TABLE public.application_log ADD CONSTRAINT application_log_verification_status_check
 CHECK (verification_status IS NULL OR verification_status IN ('confirmed','unverified','user_confirmed','admin_confirmed'));

CREATE OR REPLACE FUNCTION public.guard_match_application_control() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
DECLARE privileged boolean;
BEGIN
 privileged := current_user IN ('postgres','supabase_admin','service_role') OR coalesce(auth.role(),'')='service_role'
   OR EXISTS(SELECT 1 FROM public.dispatch_admins WHERE user_id=auth.uid());
 IF TG_OP='UPDATE' THEN
   IF NEW.discovered_at IS DISTINCT FROM OLD.discovered_at THEN
     RAISE EXCEPTION 'The original discovery date cannot be changed';
   END IF;
   IF NOT privileged AND (NEW.status IS DISTINCT FROM OLD.status
     OR NEW.admin_application_requested_at IS DISTINCT FROM OLD.admin_application_requested_at
     OR NEW.admin_applied_at IS DISTINCT FROM OLD.admin_applied_at
     OR NEW.admin_applied_by IS DISTINCT FROM OLD.admin_applied_by
     OR NEW.agent_skipped_at IS DISTINCT FROM OLD.agent_skipped_at
     OR NEW.skip_reason IS DISTINCT FROM OLD.skip_reason) THEN
     RAISE EXCEPTION 'Applications are admin controlled. Use Request Apply instead.';
   END IF;
 END IF;
 IF NEW.agent_skipped_at IS NULL AND NEW.status='skipped' THEN NEW.agent_skipped_at=now(); END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_match_application_control ON public.job_matches;
CREATE TRIGGER guard_match_application_control BEFORE INSERT OR UPDATE ON public.job_matches
 FOR EACH ROW EXECUTE FUNCTION public.guard_match_application_control();

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
 UPDATE public.job_matches SET status='approved',
  admin_application_requested_at=coalesce(admin_application_requested_at,now()) WHERE id=m.id;
 RETURN jsonb_build_object('id',m.id,'status','approved');
END $$;

CREATE OR REPLACE FUNCTION public.admin_record_application(
 p_match_id uuid, p_outcome text, p_notes text DEFAULT NULL,
 p_confirmation_text text DEFAULT NULL, p_confirmation_url text DEFAULT NULL,
 p_reference text DEFAULT NULL, p_receipt_checked boolean DEFAULT false
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.job_matches; log_id uuid;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.dispatch_admins WHERE user_id=auth.uid())
 THEN RAISE EXCEPTION 'Admin access is required'; END IF;
 IF p_outcome IS NULL OR p_outcome NOT IN ('success','failed','needs_manual_action','submission_unverified','captcha_blocked')
 THEN RAISE EXCEPTION 'Invalid application outcome'; END IF;
 SELECT * INTO m FROM public.job_matches WHERE id=p_match_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Match not found'; END IF;
 IF m.status='applied' THEN
   IF p_outcome='success' THEN RETURN jsonb_build_object('id',m.id,'status','applied','already_recorded',true); END IF;
   RAISE EXCEPTION 'A completed application cannot be overwritten with a failure';
 END IF;
 IF p_outcome='success' AND (NOT coalesce(p_receipt_checked,false)
   OR length(trim(coalesce(p_confirmation_text,'')))<8
   OR coalesce(p_confirmation_url,'') !~ '^https://[^ /]+')
 THEN RAISE EXCEPTION 'Confirm actual employer receipt and provide confirmation details plus an HTTPS employer URL'; END IF;
 IF p_outcome='success' AND lower(p_confirmation_url) ~ '^https://([^/]+\.)?adzuna\.[^/]+' THEN RAISE EXCEPTION 'Use the actual employer confirmation URL, not an Adzuna advert'; END IF;
 IF p_outcome<>'success' AND nullif(trim(coalesce(p_notes,'')),'') IS NULL
 THEN RAISE EXCEPTION 'Describe what prevented completion'; END IF;
 INSERT INTO public.application_log(job_match_id,job_seeker_id,result,notes,verification_status,
   confirmation_text,confirmation_url,confirmation_reference,recorded_by)
 VALUES(m.id,m.job_seeker_id,p_outcome,trim(p_notes),
   CASE WHEN p_outcome='success' THEN 'admin_confirmed' WHEN p_outcome='submission_unverified' THEN 'unverified' ELSE NULL END,
   CASE WHEN p_outcome='success' THEN trim(p_confirmation_text) ELSE NULL END,
   nullif(trim(p_confirmation_url),''),nullif(trim(p_reference),''),auth.uid()) RETURNING id INTO log_id;
 UPDATE public.job_matches SET status=CASE WHEN p_outcome='success' THEN 'applied' ELSE p_outcome END,
   decided_at=now(),admin_applied_at=CASE WHEN p_outcome='success' THEN now() ELSE NULL END,
   admin_applied_by=CASE WHEN p_outcome='success' THEN auth.uid() ELSE NULL END WHERE id=m.id;
 RETURN jsonb_build_object('id',m.id,'status',CASE WHEN p_outcome='success' THEN 'applied' ELSE p_outcome END,'application_log_id',log_id);
END $$;
REVOKE ALL ON FUNCTION public.request_job_application(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.request_job_application(uuid) TO authenticated;
REVOKE ALL ON FUNCTION public.admin_record_application(uuid,text,text,text,text,text,boolean) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_record_application(uuid,text,text,text,text,text,boolean) TO authenticated;
COMMENT ON COLUMN public.job_matches.agent_skipped_at IS 'Preserves agent skip classification through user/admin queuing until application completion.';
COMMENT ON COLUMN public.job_matches.discovered_at IS 'Original discovery timestamp, retained through all application status changes.';
