-- Additive audit metadata; existing welcome/debit rules and table write grants remain intact.
ALTER TABLE public.application_credit_ledger
 ADD COLUMN admin_actor_id uuid,
 ADD COLUMN admin_request_id uuid,
 ADD COLUMN admin_note text;
ALTER TABLE public.application_credit_ledger DROP CONSTRAINT application_credit_ledger_reason_check;
ALTER TABLE public.application_credit_ledger DROP CONSTRAINT application_credit_ledger_check;
ALTER TABLE public.application_credit_ledger
 ADD CONSTRAINT application_credit_ledger_reason_check CHECK (reason IN ('welcome','application_approval','admin_topup')),
 ADD CONSTRAINT application_credit_ledger_check CHECK (
  (reason='welcome' AND amount=600 AND match_id IS NULL) OR
  (reason='application_approval' AND amount=-1) OR
  (reason='admin_topup' AND amount BETWEEN 1 AND 1000000 AND match_id IS NULL
   AND admin_actor_id IS NOT NULL AND admin_request_id IS NOT NULL
   AND admin_note IS NOT NULL AND length(trim(admin_note)) BETWEEN 3 AND 500)
 ),
 ADD CONSTRAINT application_credit_ledger_admin_metadata_check CHECK (
  reason='admin_topup' OR (admin_actor_id IS NULL AND admin_request_id IS NULL AND admin_note IS NULL)
 );
CREATE UNIQUE INDEX application_credit_ledger_admin_request_unique ON public.application_credit_ledger(admin_request_id) WHERE admin_request_id IS NOT NULL;

CREATE FUNCTION public.admin_get_application_credit_balance(p_job_seeker_id uuid) RETURNS jsonb
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO public, pg_temp AS $function$
DECLARE target_user uuid; remaining integer;
BEGIN
 IF auth.uid() IS NULL OR NOT EXISTS(SELECT 1 FROM public.dispatch_admins WHERE user_id=auth.uid()) THEN
  RAISE EXCEPTION 'Admin access is required' USING ERRCODE='42501';
 END IF;
 SELECT user_id INTO target_user FROM public.job_seekers WHERE id=p_job_seeker_id;
 IF target_user IS NULL THEN RAISE EXCEPTION 'Account has no linked user'; END IF;
 SELECT balance INTO remaining FROM public.application_credit_wallets WHERE user_id=target_user;
 IF NOT FOUND THEN RAISE EXCEPTION 'Token wallet unavailable. Contact support.'; END IF;
 RETURN jsonb_build_object('job_seeker_id',p_job_seeker_id,'balance',remaining,'staff_id',auth.uid());
END $function$;

CREATE FUNCTION public.admin_top_up_application_credits(p_job_seeker_id uuid,p_amount integer,p_note text,p_request_id uuid) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public, pg_temp AS $function$
DECLARE target_user uuid; remaining integer; receipt public.application_credit_ledger; staff_id uuid:=auth.uid();
BEGIN
 IF staff_id IS NULL OR NOT EXISTS(SELECT 1 FROM public.dispatch_admins WHERE user_id=staff_id) THEN
  RAISE EXCEPTION 'Admin access is required' USING ERRCODE='42501';
 END IF;
 IF p_amount IS NULL OR p_amount<1 OR p_amount>1000000 OR p_request_id IS NULL
  OR p_note IS NULL OR length(trim(p_note)) NOT BETWEEN 3 AND 500 THEN
  RAISE EXCEPTION 'Enter a whole number of tokens (1–1000000), a reference (3–500 characters), and a request ID' USING ERRCODE='22023';
 END IF;
 SELECT user_id INTO target_user FROM public.job_seekers WHERE id=p_job_seeker_id FOR KEY SHARE;
 IF target_user IS NULL THEN RAISE EXCEPTION 'Account has no linked user'; END IF;
 -- Same lock as approval spending: concurrent additions/debits cannot overwrite one another.
 SELECT balance INTO remaining FROM public.application_credit_wallets WHERE user_id=target_user FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Token wallet unavailable. Contact support.'; END IF;
 SELECT * INTO receipt FROM public.application_credit_ledger WHERE admin_request_id=p_request_id;
 IF FOUND THEN
  IF receipt.user_id<>target_user OR receipt.amount<>p_amount OR receipt.admin_actor_id<>staff_id OR receipt.admin_note<>trim(p_note) THEN
   RAISE EXCEPTION 'This request ID belongs to a different top-up' USING ERRCODE='22023';
  END IF;
  RETURN jsonb_build_object('job_seeker_id',p_job_seeker_id,'balance',remaining,'amount',receipt.amount,'receipt_id',receipt.id,'request_id',p_request_id,'already_processed',true);
 END IF;
 IF remaining::bigint+p_amount::bigint>2147483647 THEN RAISE EXCEPTION 'This top-up would exceed the wallet limit' USING ERRCODE='22003'; END IF;
 UPDATE public.application_credit_wallets SET balance=balance+p_amount,updated_at=now() WHERE user_id=target_user RETURNING balance INTO remaining;
 INSERT INTO public.application_credit_ledger(user_id,amount,reason,balance_after,admin_actor_id,admin_request_id,admin_note)
 VALUES(target_user,p_amount,'admin_topup',remaining,staff_id,p_request_id,trim(p_note)) RETURNING * INTO receipt;
 RETURN jsonb_build_object('job_seeker_id',p_job_seeker_id,'balance',remaining,'amount',p_amount,'receipt_id',receipt.id,'request_id',p_request_id,'already_processed',false);
END $function$;
REVOKE ALL ON FUNCTION public.admin_get_application_credit_balance(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.admin_top_up_application_credits(uuid,integer,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.admin_get_application_credit_balance(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.admin_top_up_application_credits(uuid,integer,text,uuid) TO authenticated;
COMMENT ON FUNCTION public.admin_top_up_application_credits(uuid,integer,text,uuid) IS 'Staff-only additive token top-up, atomic with audited ledger entry. Request UUID prevents retry duplication. No direct wallet/ledger write grants.';
