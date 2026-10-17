DO $change$
DECLARE definition text:=pg_get_functiondef('public.request_job_application(uuid)'::regprocedure); old_message text:='You have 0 tokens. You need 1 token to approve a job. Top-ups are not available yet.';
BEGIN
 IF strpos(definition,old_message)=0 THEN RAISE EXCEPTION 'Expected zero-token message not found; no change made'; END IF;
 EXECUTE replace(definition,old_message,'You have 0 tokens. You need 1 token to approve a job. Contact support for a token top-up.');
END $change$;
