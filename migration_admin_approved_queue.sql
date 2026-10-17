CREATE OR REPLACE FUNCTION public.admin_queue_account_summaries(
 p_status text DEFAULT 'queue', p_today boolean DEFAULT false, p_search text DEFAULT ''
) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE answer jsonb; search_term text := lower(trim(coalesce(p_search,'')));
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.dispatch_admins WHERE user_id=auth.uid()) THEN
  RAISE EXCEPTION 'Admin access is required' USING ERRCODE='42501';
 END IF;
 WITH base AS MATERIALIZED (
  SELECT m.id,m.job_seeker_id,m.status,m.discovered_at,m.job_title,m.company_name,m.skip_reason,
   s.full_name,s.dedicated_email
  FROM public.job_matches m LEFT JOIN public.job_seekers s ON s.id=m.job_seeker_id
  WHERE m.admin_queue_deleted_at IS NULL
   AND m.admin_application_requested_at IS NOT NULL
   AND coalesce(m.job_title,'') NOT IN ('⚠ Watched page could not be read (not a job)','(watched page)')
 ), filtered AS (
  SELECT b.* FROM base b WHERE
   (p_status='all' OR (p_status='queue' AND b.status IN ('approved','failed','needs_manual_action','captcha_blocked','submission_unverified')) OR b.status=p_status)
   AND (NOT coalesce(p_today,false) OR (
    b.discovered_at >= ((now() AT TIME ZONE 'Africa/Johannesburg')::date::timestamp AT TIME ZONE 'Africa/Johannesburg')
    AND b.discovered_at < (((now() AT TIME ZONE 'Africa/Johannesburg')::date+1)::timestamp AT TIME ZONE 'Africa/Johannesburg')
   ))
   AND (search_term='' OR strpos(lower(concat_ws(' ',b.job_title,b.company_name,b.full_name,b.dedicated_email,b.skip_reason)),search_term)>0
    OR EXISTS(SELECT 1 FROM public.application_log l WHERE l.job_match_id=b.id AND strpos(lower(coalesce(l.notes,'')),search_term)>0))
 ), grouped AS (
  SELECT job_seeker_id,full_name,dedicated_email,count(*) AS job_count,count(*) FILTER(WHERE status='approved') AS request_count
  FROM filtered GROUP BY job_seeker_id,full_name,dedicated_email
 )
 SELECT jsonb_build_object(
  'accounts',coalesce((SELECT jsonb_agg(jsonb_build_object('id',job_seeker_id,'name',coalesce(nullif(full_name,''),nullif(dedicated_email,''),'Account unavailable'),'email',coalesce(dedicated_email,''),'job_count',job_count,'request_count',request_count)) FROM grouped),'[]'::jsonb),
  'total_saved',(SELECT count(*) FROM base),
  'matching_jobs',(SELECT count(*) FROM filtered),
  'counts',coalesce((SELECT jsonb_object_agg(status,n) FROM (SELECT status,count(*) AS n FROM base GROUP BY status) c),'{}'::jsonb)
 ) INTO answer;
 RETURN answer;
END $function$;
REVOKE ALL ON FUNCTION public.admin_queue_account_summaries(text,boolean,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_queue_account_summaries(text,boolean,text) TO authenticated;
COMMENT ON FUNCTION public.admin_queue_account_summaries(text,boolean,text) IS 'Admin-only account cards and counts for explicitly user-requested applications. Unapproved discoveries excluded in every filter. Approval provenance retained through outcomes.';
