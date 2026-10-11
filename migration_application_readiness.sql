-- Applications require validated, applicant-confirmed profile data. Discovery is unchanged.
ALTER TABLE public.job_seekers ADD COLUMN IF NOT EXISTS application_profile_confirmed_at timestamptz;
ALTER TABLE public.job_seekers ADD COLUMN IF NOT EXISTS application_profile_confirmation_hash text;

CREATE OR REPLACE FUNCTION public.application_value_present(v text) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=public,pg_temp AS $$
 SELECT v IS NOT NULL AND btrim(v)<>'' AND lower(btrim(v)) !~ '^(null|undefined|test|demo|sample|unknown|n/?a|not provided|0+)$'
 AND lower(btrim(v)) !~ '(^|[[:space:]_-])(test|demo|sample)([[:space:]_-]|$)';
$$;
CREATE OR REPLACE FUNCTION public.valid_sa_identity_number(v text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE n integer; total integer:=0; i integer;
BEGIN
 IF v IS NULL OR v !~ '^[0-9]{13}$' OR v ~ '^([0-9])\1+$' THEN RETURN false; END IF;
 FOR i IN 1..13 LOOP
  n:=substring(v,i,1)::integer;
  IF i % 2=0 THEN n:=n*2; IF n>9 THEN n:=n-9; END IF; END IF;
  total:=total+n;
 END LOOP;
 RETURN total % 10=0;
END $$;

CREATE OR REPLACE FUNCTION public.application_profile_fingerprint(p_seeker_id uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
 SELECT md5(jsonb_build_object(
  'profile',jsonb_build_object('full_name',s.full_name,'email',s.dedicated_email,'phone',s.phone,'phone_alt',s.phone_alt,
   'id_type',s.id_type,'id_number',s.id_number,'dob',s.date_of_birth,'gender',s.gender,'race',s.race,
   'nationality',s.nationality,'right_to_work_sa',s.right_to_work_sa,'address',s.physical_address,'city',s.city,
   'province',s.province,'postal_code',s.postal_code,'own_transport',s.own_transport,'drivers_license',s.drivers_license,
   'relocate',s.willing_to_relocate,'notice',s.notice_period_days,'available',s.available_from,
   'current_employer',s.current_employer,'position',s.current_position,'experience',s.years_experience,
   'qualification',s.highest_qualification,'field_of_study',s.field_of_study,'skills',s.skills,'languages',s.languages,
   'bio',s.bio,'resume_url',s.resume_url,'resume_text',s.resume_text,'salary_min',s.salary_min,'salary_max',s.salary_max),
  'employment',coalesce((SELECT jsonb_agg(to_jsonb(e)-'id'-'created_at'-'updated_at'-'job_seeker_id' ORDER BY e.sort_order,e.company,e.position,e.start_date) FROM public.job_seeker_employment e WHERE e.job_seeker_id=s.id),'[]'::jsonb),
  'education',coalesce((SELECT jsonb_agg(to_jsonb(e)-'id'-'created_at'-'updated_at'-'job_seeker_id' ORDER BY e.sort_order,e.institution,e.qualification) FROM public.job_seeker_education e WHERE e.job_seeker_id=s.id),'[]'::jsonb),
  'references',coalesce((SELECT jsonb_agg(to_jsonb(r)-'id'-'created_at'-'job_seeker_id' ORDER BY r.sort_order,r.full_name) FROM public.job_seeker_references r WHERE r.job_seeker_id=s.id),'[]'::jsonb),
  'documents',coalesce((SELECT jsonb_agg(jsonb_build_object('type',d.doc_type,'url',d.file_url,'name',d.file_name) ORDER BY d.doc_type,d.file_url,d.file_name) FROM public.job_seeker_documents d WHERE d.job_seeker_id=s.id),'[]'::jsonb)
 )::text) FROM public.job_seekers s WHERE s.id=p_seeker_id;
$$;

CREATE OR REPLACE FUNCTION public.application_readiness_errors(p_seeker_id uuid) RETURNS text[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.job_seekers; missing text[]:=ARRAY[]::text[]; v text; digits text;
BEGIN
 SELECT * INTO s FROM public.job_seekers WHERE id=p_seeker_id;
 IF NOT FOUND THEN RETURN ARRAY['Save your applicant profile']; END IF;
 IF NOT public.application_value_present(s.full_name) OR s.full_name !~ '[[:alpha:]]+[[:space:]]+[[:alpha:]]+' THEN missing:=array_append(missing,'Full legal name (no test or placeholder names)'); END IF;
 IF NOT public.application_value_present(s.dedicated_email) OR s.dedicated_email !~* '^[^[:space:]@]+@[^[:space:]@]+\.[a-z]{2,}$' OR s.dedicated_email ~* '@([^@]*\.)?(example\.(com|org|net)|[^@]*\.invalid|[^@]*\.test)$' THEN missing:=array_append(missing,'Valid application email'); END IF;
 digits:=regexp_replace(coalesce(s.phone,''),'[^0-9]','','g');
 IF length(digits)<9 OR length(digits)>15 OR digits ~ '^([0-9])\1+$' THEN missing:=array_append(missing,'Valid primary phone number'); END IF;
 IF s.id_type='sa_id' THEN
  IF NOT public.valid_sa_identity_number(s.id_number) THEN missing:=array_append(missing,'Valid-format South African ID number (13 digits and checksum)'); END IF;
 ELSIF s.id_type='passport' THEN
  IF NOT public.application_value_present(s.id_number) OR s.id_number !~ '^[A-Za-z0-9]{6,20}$' THEN missing:=array_append(missing,'Passport number (6–20 letters/digits)'); END IF;
 ELSE missing:=array_append(missing,'ID type: South African ID or passport'); END IF;
 IF s.date_of_birth IS NULL OR s.date_of_birth>=current_date OR s.date_of_birth<date '1900-01-01' THEN missing:=array_append(missing,'Actual date of birth'); END IF;
 IF NOT public.application_value_present(s.gender) THEN missing:=array_append(missing,'Gender'); END IF;
 IF NOT public.application_value_present(s.nationality) THEN missing:=array_append(missing,'Actual nationality'); END IF;
 IF s.right_to_work_sa IS NULL THEN missing:=array_append(missing,'Answer whether you currently have the right to work in South Africa'); END IF;
 IF NOT public.application_value_present(s.physical_address) THEN missing:=array_append(missing,'Actual street address'); END IF;
 IF NOT public.application_value_present(s.city) THEN missing:=array_append(missing,'Actual current city'); END IF;
 IF s.province IS NULL OR s.province NOT IN ('Gauteng','Western Cape','KwaZulu-Natal','Eastern Cape','Free State','Limpopo','Mpumalanga','North West','Northern Cape','Outside South Africa') THEN missing:=array_append(missing,'Current province, or Outside South Africa if applicable'); END IF;
 IF NOT public.application_value_present(s.postal_code) THEN missing:=array_append(missing,'Actual postal code'); END IF;
 IF (s.notice_period_days IS NULL OR s.notice_period_days<0) AND s.available_from IS NULL THEN missing:=array_append(missing,'Notice period or availability date'); END IF;
 IF s.years_experience IS NULL OR s.years_experience<0 THEN missing:=array_append(missing,'Total years of experience (enter 0 if you have not worked)'); END IF;
 IF coalesce(s.years_experience,0)>0 OR public.application_value_present(s.current_employer) OR public.application_value_present(s.current_position) OR EXISTS(SELECT 1 FROM public.job_seeker_employment WHERE job_seeker_id=s.id) THEN
  IF NOT EXISTS(SELECT 1 FROM public.job_seeker_employment WHERE job_seeker_id=s.id) OR EXISTS(
   SELECT 1 FROM public.job_seeker_employment e WHERE e.job_seeker_id=s.id AND
   (NOT public.application_value_present(e.company) OR NOT public.application_value_present(e.position) OR e.start_date IS NULL OR e.start_date>current_date OR
    (coalesce(e.is_current,false) AND e.end_date IS NOT NULL) OR (NOT coalesce(e.is_current,false) AND (e.end_date IS NULL OR e.end_date<e.start_date OR e.end_date>current_date))))
  THEN missing:=array_append(missing,'Complete employment history: employer, position, start date, and end date or Currently work here'); END IF;
 END IF;
 IF NOT public.application_value_present(s.highest_qualification) THEN missing:=array_append(missing,'Highest qualification, or No formal qualification'); END IF;
 IF s.highest_qualification IS DISTINCT FROM 'No formal qualification' AND (NOT EXISTS(SELECT 1 FROM public.job_seeker_education WHERE job_seeker_id=s.id) OR EXISTS(
  SELECT 1 FROM public.job_seeker_education e WHERE e.job_seeker_id=s.id AND (NOT public.application_value_present(e.institution) OR NOT public.application_value_present(e.qualification) OR
   (e.start_year IS NOT NULL AND (e.start_year<1900 OR e.start_year>extract(year from current_date))) OR
   (e.end_year IS NOT NULL AND (e.end_year<1900 OR e.end_year>extract(year from current_date) OR e.end_year<coalesce(e.start_year,e.end_year)))))
 ) THEN missing:=array_append(missing,'Education history: institution and qualification with truthful dates if supplied'); END IF;
 IF coalesce(cardinality(s.skills),0)=0 OR EXISTS(SELECT 1 FROM unnest(s.skills) x WHERE NOT public.application_value_present(x)) THEN missing:=array_append(missing,'Actual skills'); END IF;
 IF coalesce(cardinality(s.languages),0)=0 OR EXISTS(SELECT 1 FROM unnest(s.languages) x WHERE NOT public.application_value_present(x)) THEN missing:=array_append(missing,'Languages'); END IF;
 IF coalesce(cardinality(s.job_title_keywords),0)=0 THEN missing:=array_append(missing,'Target job titles'); END IF;
 IF coalesce(cardinality(s.preferred_locations),0)=0 THEN missing:=array_append(missing,'Preferred South African job locations'); END IF;
 IF coalesce(cardinality(s.apply_qualifications),0)=0 OR coalesce(cardinality(s.apply_experience_ranges),0)=0 THEN missing:=array_append(missing,'Application qualification levels and experience ranges'); END IF;
 IF public.application_value_present(s.resume_url) THEN
  IF s.resume_url !~* '^https://' OR s.resume_url ~* '(^|[/ _-])(demo|test|sample)([._/-]|$)' THEN missing:=array_append(missing,'Usable current CV file (not a demo/test CV)'); END IF;
 ELSE
  IF NOT public.application_value_present(s.bio) OR length(btrim(coalesce(s.bio,'')))<30 THEN missing:=array_append(missing,'Upload a current CV, or add a genuine bio of at least 30 characters for a profile-generated CV'); END IF;
 END IF;
 RETURN missing;
END $$;

CREATE OR REPLACE FUNCTION public.get_application_readiness(p_seeker_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.job_seekers; missing text[]; confirmed boolean;
BEGIN
 SELECT * INTO s FROM public.job_seekers WHERE id=p_seeker_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'Applicant profile not found'; END IF;
 IF auth.role() IS DISTINCT FROM 'service_role' AND (auth.uid() IS NULL OR (s.user_id IS DISTINCT FROM auth.uid() AND NOT EXISTS(SELECT 1 FROM public.dispatch_admins WHERE user_id=auth.uid()))) THEN RAISE EXCEPTION 'Not authorised to read this applicant readiness'; END IF;
 missing:=public.application_readiness_errors(s.id);
 confirmed:=s.application_profile_confirmed_at IS NOT NULL AND s.application_profile_confirmation_hash=public.application_profile_fingerprint(s.id);
 IF NOT coalesce(confirmed,false) THEN missing:=array_append(missing,'Confirm that your saved information is real, current and not test data'); END IF;
 RETURN jsonb_build_object('ready',cardinality(missing)=0,'status',CASE WHEN cardinality(missing)=0 THEN 'ready' ELSE 'awaiting_applicant_information' END,
  'missing',to_jsonb(missing),'profile_confirmed',coalesce(confirmed,false),
  'cv_mode',CASE WHEN public.application_value_present(s.resume_url) THEN 'uploaded' ELSE 'profile_generated' END,
  'document_types',coalesce((SELECT jsonb_agg(DISTINCT doc_type) FROM public.job_seeker_documents WHERE job_seeker_id=s.id),'[]'::jsonb),
  'note','Basic readiness does not guarantee eligibility or submission. Vacancy-specific documents, declarations and candidate account access are checked separately.');
END $$;

CREATE OR REPLACE FUNCTION public.confirm_application_profile() RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE s public.job_seekers; missing text[];
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
 SELECT * INTO s FROM public.job_seekers WHERE user_id=auth.uid() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Save your profile first'; END IF;
 missing:=public.application_readiness_errors(s.id);
 IF cardinality(missing)>0 THEN RAISE EXCEPTION 'Profile saved, but not application ready: %',array_to_string(missing,'; '); END IF;
 UPDATE public.job_seekers SET application_profile_confirmed_at=now(),application_profile_confirmation_hash=public.application_profile_fingerprint(s.id) WHERE id=s.id;
 RETURN public.get_application_readiness(s.id);
END $$;

CREATE OR REPLACE FUNCTION public.protect_application_profile_confirmation() RETURNS trigger
LANGUAGE plpgsql SET search_path=public,pg_temp AS $$
BEGIN
 IF current_user IN ('authenticated','anon') THEN
  IF TG_OP='INSERT' THEN
   IF NEW.application_profile_confirmed_at IS NOT NULL OR NEW.application_profile_confirmation_hash IS NOT NULL THEN RAISE EXCEPTION 'Use confirm_application_profile to confirm applicant information'; END IF;
  ELSIF NEW.application_profile_confirmed_at IS DISTINCT FROM OLD.application_profile_confirmed_at OR NEW.application_profile_confirmation_hash IS DISTINCT FROM OLD.application_profile_confirmation_hash THEN
   RAISE EXCEPTION 'Use confirm_application_profile to confirm applicant information';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS protect_application_profile_confirmation ON public.job_seekers;
CREATE TRIGGER protect_application_profile_confirmation BEFORE INSERT OR UPDATE ON public.job_seekers FOR EACH ROW EXECUTE FUNCTION public.protect_application_profile_confirmation();

CREATE OR REPLACE FUNCTION public.request_job_application(p_match_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE m public.job_matches; s public.job_seekers; readiness jsonb;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Sign in first'; END IF;
 SELECT * INTO m FROM public.job_matches WHERE id=p_match_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Match not found'; END IF;
 SELECT * INTO s FROM public.job_seekers WHERE id=m.job_seeker_id AND user_id=auth.uid();
 IF NOT FOUND THEN RAISE EXCEPTION 'This is not your match'; END IF;
 IF s.status<>'active' THEN RAISE EXCEPTION 'Your account is not active'; END IF;
 IF m.status='applied' THEN RAISE EXCEPTION 'This job is already applied'; END IF;
 IF m.status='submission_unverified' THEN RAISE EXCEPTION 'Admin must check the earlier uncertain submission before another application'; END IF;
 readiness:=public.get_application_readiness(s.id);
 IF NOT (readiness->>'ready')::boolean THEN RAISE EXCEPTION 'Awaiting applicant information: %',(SELECT string_agg(v,'; ') FROM jsonb_array_elements_text(readiness->'missing') v); END IF;
 IF EXISTS(SELECT 1 FROM unnest(coalesce(s.blocked_companies,ARRAY[]::text[])) b WHERE lower(b)=lower(coalesce(m.company_name,'')))
 OR EXISTS(SELECT 1 FROM unnest(coalesce(s.blocked_locations,ARRAY[]::text[])) b WHERE b<>'' AND position(lower(b) in lower(coalesce(m.location,'')))>0) THEN RAISE EXCEPTION 'This company or location is blocked in your profile'; END IF;
 UPDATE public.job_matches SET status='approved',admin_application_requested_at=coalesce(admin_application_requested_at,now()) WHERE id=m.id;
 RETURN jsonb_build_object('id',m.id,'status','approved');
END $$;

REVOKE ALL ON FUNCTION public.application_value_present(text), public.valid_sa_identity_number(text), public.application_profile_fingerprint(uuid), public.application_readiness_errors(uuid), public.protect_application_profile_confirmation() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.get_application_readiness(uuid),public.confirm_application_profile(),public.request_job_application(uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.get_application_readiness(uuid) TO authenticated,service_role;
GRANT EXECUTE ON FUNCTION public.confirm_application_profile(),public.request_job_application(uuid) TO authenticated;
