-- Skipped jobs stay visible in Matches (with a reason) instead of being hidden as 'rejected'.
alter table public.job_matches add column if not exists skip_reason text;

alter table public.job_matches drop constraint if exists job_matches_status_check;
alter table public.job_matches add constraint job_matches_status_check
  check (status = any (array['pending','approved','rejected','applied','failed','needs_manual_action','seeker_paused','skipped']));

-- Bring the old agent-skipped rows back into Matches
update public.job_matches
set status = 'skipped',
    skip_reason = 'This job was skipped by the agent: ' || regexp_replace(regexp_replace(match_reason, '^Skipped: ', ''), '\.$', '') || '. You can still decide if you want to apply.',
    match_reason = null
where status = 'rejected' and match_reason like 'Skipped:%';
