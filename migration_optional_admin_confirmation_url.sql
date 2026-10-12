-- URL is optional; admin authorization, confirmation text, checkbox, and atomic outcomes remain required.
CREATE OR REPLACE FUNCTION public.admin_record_application(p_match_id uuid, p_outcome text, p_notes text DEFAULT NULL::text, p_confirmation_text text DEFAULT NULL::text, p_confirmation_url text DEFAULT NULL::text, p_reference text DEFAULT NULL::text, p_receipt_checked boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
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
   OR length(trim(coalesce(p_confirmation_text,'')))<8)
 THEN RAISE EXCEPTION 'Confirm actual employer receipt and provide confirmation details'; END IF;
 IF p_outcome='success' AND nullif(trim(coalesce(p_confirmation_url,'')),'') IS NOT NULL THEN
   IF trim(p_confirmation_url) !~ '^https://[^ /[:space:]@]+([/?#]|$)' THEN RAISE EXCEPTION 'If supplied, confirmation URL must be an HTTPS employer URL'; END IF;
   IF lower(trim(p_confirmation_url)) ~ '^https://([^/]+\.)?adzuna\.[^/]+' THEN RAISE EXCEPTION 'Use the actual employer confirmation URL, not an Adzuna advert'; END IF;
 END IF;
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
END $function$
