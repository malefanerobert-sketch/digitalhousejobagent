-- Application proof: a form is not "Applied" unless the website itself
-- returns a confirmation. Old rows deliberately stay NULL / historical:
-- we do not retroactively claim proof that was never captured.
alter table public.application_log
  add column if not exists verification_status text,
  add column if not exists submitted_fields jsonb not null default '[]'::jsonb,
  add column if not exists confirmation_text text,
  add column if not exists confirmation_reference text,
  add column if not exists confirmation_url text,
  add column if not exists confirmation_screenshot_url text;

alter table public.application_log
  drop constraint if exists application_log_verification_status_check;
alter table public.application_log
  add constraint application_log_verification_status_check
  check (verification_status is null or verification_status in ('confirmed', 'unverified', 'user_confirmed'));

alter table public.job_matches drop constraint if exists job_matches_status_check;
alter table public.job_matches add constraint job_matches_status_check
  check (status = any (array[
    'pending','approved','rejected','applied','failed','needs_manual_action',
    'seeker_paused','skipped','submission_unverified'
  ]));

comment on column public.application_log.verification_status is
  'confirmed only when the job site showed a submission receipt; unverified means Submit was clicked but no receipt appeared; null is a historical row without captured proof.';