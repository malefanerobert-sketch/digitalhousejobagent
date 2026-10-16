-- One wallet per auth identity (not per editable/deletable seeker profile).
create table public.application_credit_wallets (
 user_id uuid primary key references auth.users(id) on delete cascade,
 balance integer not null default 600 check (balance >= 0),
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create table public.application_credit_ledger (
 id uuid primary key default gen_random_uuid(),
 user_id uuid not null references auth.users(id) on delete cascade,
 match_id uuid references public.job_matches(id) on delete set null,
 amount integer not null check(amount <> 0),
 reason text not null check(reason in ('welcome','application_approval')),
 balance_after integer not null check(balance_after >= 0),
 created_at timestamptz not null default now(),
 unique(user_id,match_id),
 check((reason='welcome' and amount=600 and match_id is null) or (reason='application_approval' and amount=-1))
);
create unique index application_credit_welcome_once on public.application_credit_ledger(user_id) where reason='welcome';
create index application_credit_ledger_history on public.application_credit_ledger(user_id,created_at desc);
alter table public.application_credit_wallets enable row level security;
alter table public.application_credit_ledger enable row level security;
revoke all on public.application_credit_wallets,public.application_credit_ledger from anon,authenticated;
grant select on public.application_credit_wallets,public.application_credit_ledger to authenticated;
grant all on public.application_credit_wallets,public.application_credit_ledger to service_role;
create policy credit_wallet_read on public.application_credit_wallets for select to authenticated using(user_id=(select auth.uid()) or exists(select 1 from public.dispatch_admins a where a.user_id=(select auth.uid())));
create policy credit_ledger_read on public.application_credit_ledger for select to authenticated using(user_id=(select auth.uid()) or exists(select 1 from public.dispatch_admins a where a.user_id=(select auth.uid())));
create function public.initialize_application_credits() returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
 insert into public.application_credit_wallets(user_id) values(new.id);
 insert into public.application_credit_ledger(user_id,amount,reason,balance_after) values(new.id,600,'welcome',600);
 return new;
end $$;
revoke all on function public.initialize_application_credits() from public,anon,authenticated;
create trigger initialize_application_credits after insert on auth.users for each row execute function public.initialize_application_credits();
-- Launch grant only. No retrospective deductions and no balance reset on profile saves.
insert into public.application_credit_wallets(user_id) select id from auth.users on conflict do nothing;
insert into public.application_credit_ledger(user_id,amount,reason,balance_after) select user_id,600,'welcome',balance from public.application_credit_wallets on conflict do nothing;
create or replace function public.request_job_application(p_match_id uuid) returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare m public.job_matches; s public.job_seekers; remaining integer; charged boolean:=false;
begin
 if auth.uid() is null then raise exception 'Sign in first' using errcode='42501'; end if;
 select * into m from public.job_matches where id=p_match_id for update;
 if not found then raise exception 'Match not found'; end if;
 select * into s from public.job_seekers where id=m.job_seeker_id and user_id=auth.uid();
 if not found then raise exception 'This is not your match' using errcode='42501'; end if;
 if s.status<>'active' then raise exception 'Your account is not active'; end if;
 if m.status='applied' then raise exception 'This job is already applied'; end if;
 if m.status='submission_unverified' then raise exception 'Admin must check the earlier uncertain submission before another application'; end if;
 if exists(select 1 from unnest(coalesce(s.blocked_companies,array[]::text[])) b where lower(b)=lower(coalesce(m.company_name,'')))
 or exists(select 1 from unnest(coalesce(s.blocked_locations,array[]::text[])) b where b<>'' and position(lower(b) in lower(coalesce(m.location,'')))>0)
 then raise exception 'This company or location is blocked in your profile'; end if;
 -- Serialize all spending for this user, including different jobs/tabs.
 select balance into remaining from public.application_credit_wallets where user_id=auth.uid() for update;
 if not found then raise exception 'Credit wallet unavailable. Contact support.'; end if;
 if m.admin_application_requested_at is null and m.status<>'approved'
 and not exists(select 1 from public.application_credit_ledger where user_id=auth.uid() and match_id=m.id and reason='application_approval') then
  if remaining<1 then raise exception 'You have 0 tokens. You need 1 token to approve a job. Top-ups are not available yet.' using errcode='P0001'; end if;
  update public.application_credit_wallets set balance=balance-1,updated_at=now() where user_id=auth.uid() returning balance into remaining;
  insert into public.application_credit_ledger(user_id,match_id,amount,reason,balance_after) values(auth.uid(),m.id,-1,'application_approval',remaining);
  charged:=true;
 end if;
 update public.job_matches set status='approved',admin_queue_deleted_at=null,admin_application_requested_at=coalesce(admin_application_requested_at,now()) where id=m.id;
 return jsonb_build_object('id',m.id,'status','approved','credit_balance',remaining,'tokens_used',case when charged then 1 else 0 end,'charged',charged);
end $$;
revoke all on function public.request_job_application(uuid) from public,anon;
grant execute on function public.request_job_application(uuid) to authenticated;
