CREATE TABLE IF NOT EXISTS public.job_discovery_candidates (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 job_seeker_id uuid NOT NULL REFERENCES public.job_seekers(id) ON DELETE CASCADE,
 job_url text NOT NULL,
 payload jsonb NOT NULL,
 attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
 next_attempt_at timestamptz NOT NULL DEFAULT now(),
 last_error text,
 created_at timestamptz NOT NULL DEFAULT now(),
 updated_at timestamptz NOT NULL DEFAULT now(),
 UNIQUE (job_seeker_id,job_url)
);
ALTER TABLE public.job_discovery_candidates ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.job_discovery_candidates FROM anon,authenticated;
GRANT ALL ON public.job_discovery_candidates TO service_role;
CREATE INDEX IF NOT EXISTS job_discovery_candidates_due_idx ON public.job_discovery_candidates(next_attempt_at,id);
COMMENT ON TABLE public.job_discovery_candidates IS 'Worker-only unpublished candidates awaiting complete advert capture. Not applicant matches or historical-match repair.';
