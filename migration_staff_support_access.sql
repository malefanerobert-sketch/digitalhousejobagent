CREATE TABLE IF NOT EXISTS public.admin_user_support_access_log (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 staff_user_id uuid NOT NULL,
 job_seeker_id uuid NOT NULL,
 accessed_at timestamptz NOT NULL DEFAULT now(),
 access_mode text NOT NULL DEFAULT 'read_only' CHECK (access_mode='read_only')
);
ALTER TABLE public.admin_user_support_access_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.admin_user_support_access_log FROM anon,authenticated;
GRANT SELECT ON public.admin_user_support_access_log TO authenticated;
CREATE POLICY admin_read_support_access_log ON public.admin_user_support_access_log FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.dispatch_admins a WHERE a.user_id=(SELECT auth.uid())));
CREATE INDEX IF NOT EXISTS admin_support_access_recent_idx ON public.admin_user_support_access_log(job_seeker_id,accessed_at DESC);
CREATE OR REPLACE FUNCTION public.admin_open_user_support(p_seeker_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,pg_temp
AS $function$
DECLARE profile jsonb; access_id uuid;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.dispatch_admins WHERE user_id=auth.uid()) THEN
  RAISE EXCEPTION 'Authorized staff access is required' USING ERRCODE='42501';
 END IF;
 SELECT to_jsonb(s)-ARRAY['api_key','ai_api_key','resume_text'] INTO profile FROM public.job_seekers s WHERE s.id=p_seeker_id;
 IF profile IS NULL THEN RAISE EXCEPTION 'User account not found' USING ERRCODE='P0002'; END IF;
 INSERT INTO public.admin_user_support_access_log(staff_user_id,job_seeker_id) VALUES(auth.uid(),p_seeker_id) RETURNING id INTO access_id;
 RETURN jsonb_build_object('profile',profile,'read_only',true,'access_id',access_id,'staff_user_id',auth.uid());
END $function$;
REVOKE ALL ON FUNCTION public.admin_open_user_support(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_open_user_support(uuid) TO authenticated;
-- Existing admin SELECT policies already cover matches, applications and profile
-- sub-tables. Documents previously had an owner-only policy; add SELECT only.
CREATE POLICY admin_read_support_documents ON public.job_seeker_documents FOR SELECT TO authenticated USING (EXISTS(SELECT 1 FROM public.dispatch_admins a WHERE a.user_id=(SELECT auth.uid())));
COMMENT ON TABLE public.admin_user_support_access_log IS 'Audited staff read-only user-app access. No user passwords, API keys, session tokens or impersonation tokens.';
