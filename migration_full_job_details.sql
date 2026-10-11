ALTER TABLE public.job_matches ADD COLUMN IF NOT EXISTS job_description_status text NOT NULL DEFAULT 'legacy';
ALTER TABLE public.job_matches ADD COLUMN IF NOT EXISTS job_description_checked_at timestamptz;
ALTER TABLE public.job_matches ADD CONSTRAINT job_matches_description_status_check CHECK (job_description_status IN ('legacy','captured','limited','unavailable'));
CREATE INDEX IF NOT EXISTS job_matches_description_refresh_idx ON public.job_matches(job_description_checked_at,discovered_at) WHERE job_description_status <> 'captured';
COMMENT ON COLUMN public.job_matches.job_description_status IS 'captured = source advert text captured without AI summarisation; limited/unavailable = never present as full details; legacy = awaiting source check';
