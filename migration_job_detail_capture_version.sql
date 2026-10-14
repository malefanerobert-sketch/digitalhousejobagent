ALTER TABLE public.job_matches ADD COLUMN IF NOT EXISTS job_description_capture_version smallint NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.job_matches.job_description_capture_version IS 'Extractor version used for bounded job-advert repair; does not change match/application status.';
