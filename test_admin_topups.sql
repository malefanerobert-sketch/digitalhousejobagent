BEGIN;
DO $setup$
DECLARE staff uuid:=gen_random_uuid(); applicant uuid:=gen_random_uuid(); other_user uuid:=gen_random_uuid(); seeker uuid;
BEGIN
 INSERT INTO auth.users(id,email,raw_user_meta_data) VALUES(staff,staff::text||'@topup-fixture.invalid','{"full_name":"Topup Test Staff"}'),(applicant,applicant::text||'@topup-fixture.invalid','{"full_name":"Topup Test Applicant"}'),(other_user,other_user::text||'@topup-fixture.invalid','{"full_name":"Topup Test Other"}');
 INSERT INTO public.dispatch_admins(user_id) VALUES(staff);
 SELECT id INTO seeker FROM public.job_seekers WHERE user_id=applicant;
 PERFORM set_config('test.topup_staff',staff::text,true);PERFORM set_config('test.topup_applicant',applicant::text,true);PERFORM set_config('test.topup_other',other_user::text,true);PERFORM set_config('test.topup_seeker',seeker::text,true);
END $setup$;
SET LOCAL ROLE authenticated;
DO $test$
DECLARE seeker uuid:=current_setting('test.topup_seeker')::uuid; req uuid:=gen_random_uuid(); r jsonb; blocked boolean; invalid_amount integer; before_count integer;
BEGIN
 PERFORM set_config('request.jwt.claim.sub',current_setting('test.topup_staff'),true);
 r:=public.admin_get_application_credit_balance(seeker);IF (r->>'balance')::int<>600 THEN RAISE EXCEPTION 'Welcome credits changed';END IF;
 r:=public.admin_top_up_application_credits(seeker,125,'Fixture support credit',req);
 IF (r->>'balance')::int<>725 OR (r->>'amount')::int<>125 OR (r->>'already_processed')::boolean THEN RAISE EXCEPTION 'Addition failed';END IF;
 r:=public.admin_top_up_application_credits(seeker,125,'Fixture support credit',req);
 IF (r->>'balance')::int<>725 OR NOT (r->>'already_processed')::boolean THEN RAISE EXCEPTION 'Retry duplicated';END IF;
 IF (SELECT count(*) FROM public.application_credit_ledger WHERE admin_request_id=req)<>1 OR NOT EXISTS(SELECT 1 FROM public.application_credit_ledger WHERE admin_request_id=req AND reason='admin_topup' AND admin_actor_id=current_setting('test.topup_staff')::uuid AND amount=125 AND balance_after=725 AND admin_note='Fixture support credit') THEN RAISE EXCEPTION 'Audit invalid';END IF;
 blocked:=false;BEGIN PERFORM public.admin_top_up_application_credits(seeker,126,'Fixture support credit',req);EXCEPTION WHEN invalid_parameter_value THEN blocked:=true;END;IF NOT blocked THEN RAISE EXCEPTION 'Idempotency payload mismatch allowed';END IF;
 FOREACH invalid_amount IN ARRAY ARRAY[0,-1,1000001,NULL::integer] LOOP
  blocked:=false;BEGIN PERFORM public.admin_top_up_application_credits(seeker,invalid_amount,'Fixture invalid amount',gen_random_uuid());EXCEPTION WHEN invalid_parameter_value THEN blocked:=true;END;IF NOT blocked THEN RAISE EXCEPTION 'Invalid amount accepted';END IF;
 END LOOP;
 blocked:=false;BEGIN PERFORM public.admin_top_up_application_credits(seeker,1,'',gen_random_uuid());EXCEPTION WHEN invalid_parameter_value THEN blocked:=true;END;IF NOT blocked THEN RAISE EXCEPTION 'Missing reason accepted';END IF;
 blocked:=false;BEGIN PERFORM public.admin_top_up_application_credits(gen_random_uuid(),1,'Missing applicant',gen_random_uuid());EXCEPTION WHEN raise_exception THEN blocked:=true;END;IF NOT blocked THEN RAISE EXCEPTION 'Missing account accepted';END IF;
 blocked:=false;BEGIN UPDATE public.application_credit_wallets SET balance=999999 WHERE user_id=current_setting('test.topup_applicant')::uuid;EXCEPTION WHEN insufficient_privilege THEN blocked:=true;END;IF NOT blocked THEN RAISE EXCEPTION 'Direct balance write allowed';END IF;
 PERFORM set_config('request.jwt.claim.sub',current_setting('test.topup_applicant'),true);
 IF (SELECT balance FROM public.application_credit_wallets WHERE user_id=auth.uid())<>725 THEN RAISE EXCEPTION 'User cannot read updated wallet';END IF;
 blocked:=false;BEGIN PERFORM public.admin_top_up_application_credits(seeker,100,'Nonadmin attempted',gen_random_uuid());EXCEPTION WHEN insufficient_privilege THEN blocked:=true;END;IF NOT blocked THEN RAISE EXCEPTION 'Nonadmin topup allowed';END IF;
 blocked:=false;BEGIN PERFORM public.admin_get_application_credit_balance(seeker);EXCEPTION WHEN insufficient_privilege THEN blocked:=true;END;IF NOT blocked THEN RAISE EXCEPTION 'Nonadmin staff reader allowed';END IF;
 IF EXISTS(SELECT 1 FROM public.application_credit_wallets WHERE user_id=current_setting('test.topup_other')::uuid) THEN RAISE EXCEPTION 'Other user wallet visible';END IF;
 PERFORM set_config('request.jwt.claim.sub','',true);
 blocked:=false;BEGIN PERFORM public.admin_top_up_application_credits(seeker,100,'Unsigned attempted',gen_random_uuid());EXCEPTION WHEN insufficient_privilege THEN blocked:=true;END;IF NOT blocked THEN RAISE EXCEPTION 'Unsigned topup allowed';END IF;
END $test$;
RESET ROLE;
-- Overflow must not partially update a wallet or write a receipt.
UPDATE public.application_credit_wallets SET balance=2147483647 WHERE user_id=current_setting('test.topup_applicant')::uuid;
SET LOCAL ROLE authenticated;
DO $overflow$
DECLARE blocked boolean:=false;
BEGIN
 PERFORM set_config('request.jwt.claim.sub',current_setting('test.topup_staff'),true);
 BEGIN PERFORM public.admin_top_up_application_credits(current_setting('test.topup_seeker')::uuid,1,'Overflow fixture',gen_random_uuid());EXCEPTION WHEN numeric_value_out_of_range THEN blocked:=true;END;
 IF NOT blocked THEN RAISE EXCEPTION 'Overflow accepted';END IF;
 IF (SELECT count(*) FROM public.application_credit_ledger WHERE user_id=current_setting('test.topup_applicant')::uuid AND reason='admin_topup')<>1 THEN RAISE EXCEPTION 'Failed topup wrote ledger';END IF;
END $overflow$;
RESET ROLE;
ROLLBACK;
SELECT 'PASS synthetic staff top-up, current balance, 600 welcome preserved, audited receipt, retry exactly once, payload mismatch, invalid inputs, missing account, nonadmin/unsigned denial, owner reads, other-wallet isolation, no direct writes, overflow rollback. All fixtures rolled back.' AS verification;
