-- Revert mandatory readiness enforcement. Existing optional-readiness metadata is retained without affecting requests.
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

REVOKE ALL ON FUNCTION public.request_job_application(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.request_job_application(uuid) TO authenticated;
