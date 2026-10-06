-- CAPTCHA-blocked jobs must leave "Discovered": apply.js writes
-- job_matches.status = 'captcha_blocked' when it hands a CAPTCHA off to a
-- human, but that value was missing from the status check constraint, so the
-- UPDATE was silently rejected and the row stayed 'pending' — showing forever
-- as "Discovered", never surfacing in the admin report, and never retried.
alter table public.job_matches drop constraint if exists job_matches_status_check;
alter table public.job_matches add constraint job_matches_status_check
  check (status = any (array[
    'pending','approved','rejected','applied','failed','needs_manual_action',
    'seeker_paused','skipped','submission_unverified','captcha_blocked'
  ]));

-- Repair rows whose status update was rejected before this fix.
update public.job_matches m
set status = 'captcha_blocked', decided_at = now()
where m.status = 'pending'
  and exists (select 1 from application_log l
              where l.job_match_id = m.id and l.result = 'captcha_blocked');
