-- Run once in Supabase (SQL editor) BEFORE deploying the new index.html
alter table public.job_seekers
  add column if not exists apply_qualifications     text[] not null default '{}',
  add column if not exists apply_experience_ranges  text[] not null default '{}';

comment on column public.job_seekers.apply_qualifications    is 'Qualification levels the user allows the agent to apply for, e.g. {Diploma,"Honours Degrees","Master''s Degree"}';
comment on column public.job_seekers.apply_experience_ranges is 'Experience ranges (years) the user allows the agent to apply for, e.g. {1-4,4-8}';
