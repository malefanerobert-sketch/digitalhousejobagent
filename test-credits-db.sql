-- Test identities and jobs are rolled back; no real account balance is spent.
begin;
do $$
declare u uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); s uuid; t uuid; m uuid; n uuid; z uuid; b uuid; legacy uuid;
begin
 insert into auth.users(id,email,raw_user_meta_data) values(u,'credits-test-'||u||'@example.invalid','{"full_name":"Credit test fixture"}'::jsonb),(v,'credits-test-'||v||'@example.invalid','{"full_name":"Other credit test fixture"}'::jsonb);
 select id into s from public.job_seekers where user_id=u;
 select id into t from public.job_seekers where user_id=v;
 if s is null or t is null then raise exception 'Signup did not create a seeker'; end if;
 if (select balance from public.application_credit_wallets where user_id=u)<>600 or (select count(*) from public.application_credit_ledger where user_id=u and reason='welcome')<>1 then raise exception 'New signup grant failed'; end if;
 update public.job_seekers set full_name='Credit fixture saved',status='active',blocked_companies=array['Blocked fixture'] where id=s;
 if (select balance from public.application_credit_wallets where user_id=u)<>600 then raise exception 'Profile save reset balance'; end if;
 insert into public.job_matches(job_seeker_id,job_title,job_url,company_name) values(s,'Credit test 1','https://example.invalid/test1','Fixture employer') returning id into m;
 insert into public.job_matches(job_seeker_id,job_title,job_url,company_name) values(s,'Credit test 2','https://example.invalid/test2','Fixture employer') returning id into n;
 insert into public.job_matches(job_seeker_id,job_title,job_url,company_name) values(s,'Credit test 3','https://example.invalid/test3','Fixture employer') returning id into z;
 insert into public.job_matches(job_seeker_id,job_title,job_url,company_name) values(s,'Credit blocked','https://example.invalid/blocked','Blocked fixture') returning id into b;
 insert into public.job_matches(job_seeker_id,job_title,job_url,status,admin_application_requested_at) values(s,'Legacy approved','https://example.invalid/legacy','approved',now()-interval '1 day') returning id into legacy;
 perform set_config('test.credit_uid',u::text,true);perform set_config('test.other_uid',v::text,true);perform set_config('test.credit_seeker',s::text,true);
 perform set_config('test.credit_match',m::text,true);perform set_config('test.credit_match2',n::text,true);perform set_config('test.credit_match3',z::text,true);perform set_config('test.credit_blocked',b::text,true);perform set_config('test.credit_legacy',legacy::text,true);
end $$;
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('test.credit_uid'),true),set_config('request.jwt.claim.role','authenticated',true),set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.credit_uid'),'role','authenticated')::text,true);
do $$
declare r jsonb; u uuid:=current_setting('test.credit_uid')::uuid; m uuid:=current_setting('test.credit_match')::uuid;
begin
 if (select count(*) from public.application_credit_wallets where user_id=current_setting('test.other_uid')::uuid)<>0 then raise exception 'RLS leaked another wallet'; end if;
 if has_table_privilege('authenticated','public.application_credit_wallets','UPDATE') or has_table_privilege('authenticated','public.application_credit_wallets','INSERT') or has_table_privilege('authenticated','public.application_credit_ledger','INSERT') then raise exception 'Client can mint credits'; end if;
 r:=public.request_job_application(m);
 if (r->>'credit_balance')::integer<>599 or not(r->>'charged')::boolean or (r->>'tokens_used')::integer<>1 then raise exception 'First approval did not charge once: %',r; end if;
 if (select status from public.job_matches where id=m)<>'approved' then raise exception 'Debit did not queue approval'; end if;
 r:=public.request_job_application(m);
 if (r->>'credit_balance')::integer<>599 or (r->>'charged')::boolean then raise exception 'Retry charged twice'; end if;
 if (select count(*) from public.application_credit_ledger where user_id=u and match_id=m)<>1 then raise exception 'Duplicate debit ledger'; end if;
 begin
  perform public.request_job_application(current_setting('test.credit_blocked')::uuid);raise exception 'Blocked company accepted';
 exception when others then if SQLERRM='Blocked company accepted' then raise; end if;end;
 if (select balance from public.application_credit_wallets where user_id=u)<>599 then raise exception 'Rejected approval charged'; end if;
 begin
  update public.job_matches set status='approved' where id=current_setting('test.credit_match2')::uuid;raise exception 'Direct approval bypass accepted';
 exception when others then if SQLERRM='Direct approval bypass accepted' then raise; end if;end;
 begin
  update public.application_credit_wallets set balance=9000 where user_id=u;raise exception 'Wallet edit accepted';
 exception when insufficient_privilege then null;end;
end $$;
-- Different user cannot charge/approve the original user's match.
select set_config('request.jwt.claim.sub',current_setting('test.other_uid'),true),set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.other_uid'),'role','authenticated')::text,true);
do $$ begin
 begin perform public.request_job_application(current_setting('test.credit_match')::uuid);raise exception 'Cross-account approval accepted';exception when insufficient_privilege then null;end;
 if (select balance from public.application_credit_wallets where user_id=current_setting('test.other_uid')::uuid)<>600 then raise exception 'Cross-account attempt charged';end if;
end $$;
reset role;
update public.application_credit_wallets set balance=1 where user_id=current_setting('test.credit_uid')::uuid;
set local role authenticated;
select set_config('request.jwt.claim.sub',current_setting('test.credit_uid'),true),set_config('request.jwt.claims',jsonb_build_object('sub',current_setting('test.credit_uid'),'role','authenticated')::text,true);
do $$ declare r jsonb;begin
 r:=public.request_job_application(current_setting('test.credit_match2')::uuid);
 if (r->>'credit_balance')::integer<>0 or not(r->>'charged')::boolean then raise exception 'Last credit not spent correctly';end if;
 begin perform public.request_job_application(current_setting('test.credit_match3')::uuid);raise exception 'Zero-credit approval accepted';exception when others then if position('You have 0 tokens' in SQLERRM)=0 then raise;end if;end;
 if (select status from public.job_matches where id=current_setting('test.credit_match3')::uuid)<>'pending' then raise exception 'Zero balance still queued job';end if;
 r:=public.request_job_application(current_setting('test.credit_legacy')::uuid);
 if (r->>'charged')::boolean or (r->>'credit_balance')::integer<>0 then raise exception 'Legacy approval retroactively charged';end if;
 r:=public.request_job_application(current_setting('test.credit_match2')::uuid);
 if (r->>'charged')::boolean then raise exception 'Retry at zero charged';end if;
end $$;
reset role;
do $$ begin
 if has_function_privilege('anon','public.request_job_application(uuid)','EXECUTE') then raise exception 'Anonymous can approve';end if;
 if exists(select 1 from public.application_credit_wallets where balance<0) then raise exception 'Negative wallet';end if;
 -- Deleting/recreating a seeker profile must not mint another welcome grant.
 delete from public.job_seekers where id=current_setting('test.credit_seeker')::uuid;
 insert into public.job_seekers(user_id,full_name) values(current_setting('test.credit_uid')::uuid,'Recreated credit test fixture');
 if (select balance from public.application_credit_wallets where user_id=current_setting('test.credit_uid')::uuid)<>0 or (select count(*) from public.application_credit_ledger where user_id=current_setting('test.credit_uid')::uuid and reason='welcome')<>1 then raise exception 'Profile recreation reminted credits';end if;
end $$;
rollback;
select 'PASS: new auth signup 600; one welcome; profile save/recreation no reset; atomic queue/debit; retry deduplication; last credit; zero rejection; legacy no retrocharge; RLS; no client mint; cross-account and anonymous denial; fixture changes rolled back' as result;
