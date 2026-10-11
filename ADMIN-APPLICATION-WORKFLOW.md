# Discovery-only worker / admin-owned applications

## User app
Three lists and dashboard cards:
1. **Discovered matches**: every saved vacancy, all stored locations and statuses, with its original calendar discovery date. Application status changes never remove it. Only an explicit user deletion removes it. Source-error notices are not vacancies and are excluded.
2. **Skipped by agent**: jobs flagged by agent qualification/location checks. Their skip classification survives a user request and failure; they leave this list after completion (or user deletion). Apply queues an authenticated, ownership-checked admin request. No browser application is launched by the user button.
3. **Applied matches**: completed unique jobs with a genuine historical website receipt, a historical user confirmation, or a new admin-confirmed completion. Human confirmation is clearly distinguished from automated employer verification. Failure history remains available to admins.
All lists load in pages so the API's default 1000-row cap doesn't silently truncate the archive. User blocks prevent future work but do not erase saved discoveries. Search/location filters only change what is currently shown, not the archive count.

## Admin queue
- New pending discoveries and user requests are visible alongside prior manual/failed/CAPTCHA/uncertain attempts.
- User requests are prioritized. Skipped/all/completed filters allow full review.
- Open the posting, use the saved seeker details and authorized company account, and complete the employer form manually.
- Save an outcome via an admin-only database function. Success requires checked actual employer confirmation, confirmation details and an HTTPS employer URL. This is an admin attestation, not a claimed automated verification.
- Recording completion inserts the log and changes the match in a single database transaction, with admin attribution. Duplicate completion is idempotent.
- Check uncertain earlier submissions before resubmitting. The user app will not blindly requeue those.

## Railway
- `index.js` loads and schedules only watched-page and autonomous discovery.
- `APPLY_CRON` is ignored. `apply.run()` / the legacy direct apply command returns disabled without entering the application loop.
- Discovery still uses the existing relevance sources/scoring and flags skipped roles/locations. Showing all stored locations does not expand Adzuna beyond its existing country endpoint.
- Existing ten-key Groq pool stays available for discovery scoring. Prior application helpers are retained for reference, not called by the worker.

## Database / security
Apply `migration_admin_applications.sql` before deploying the pages. It preserves every existing vacancy and application log, adds skip/request/admin attribution fields, protects discovery dates, and creates narrowly permission-checked RPCs. Existing RLS is not broadened. Non-admin users cannot directly change application status or admin attribution; they use `request_job_application` for their own records. Anonymous execution is revoked.

## Testing
`node test-admin-workflow.js` tests the worker schedules, disabled direct apply, permanent all-location rendering, calendar dates, queue transitions, >1000-record loading, unique completed records, and admin outcome validation using local Chromium and mocked writes only. `node test-application-flow.js` and `node test-match-captcha.js` retain receipt/CAPTCHA helper regressions.
Database ownership/admin/receipt/atomicity/idempotence/date tests run inside a transaction that is rolled back. No real employer applications are submitted by these tests.
