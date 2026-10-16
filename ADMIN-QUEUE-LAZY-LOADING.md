# Lightweight admin application queue

## Request flow

1. Opening Application queue calls `admin_queue_account_summaries` once. Its response contains only account IDs, names, emails, job/request counts and aggregate status counts. No global job list, profiles, credentials, descriptions or application-log bodies are returned.
2. Opening a named account fetches only that account's queue rows. Newest-first ordering, complete pagination, status/search/date filters and exact action IDs are retained. Job rows include only the names/emails and notes necessary for the list; full profiles and company login details are excluded.
3. Clicking Review / apply (or View completion) fetches that one match's current profile, source login and application history. A loading/error/retry state is shown. Closing the modal clears those details, and late responses cannot reopen it.
4. Back to All accounts refreshes the small summary. Job/outcome changes appear in fresh counts. Global job/company/error searches run on the server; account searches run on its loaded rows. Overview search is debounced by 250 ms.

No saved jobs, applicant match views, discovery workers, application-submission rules or existing outcome/removal RPCs are changed.

## Database deployment

Apply `migration_admin_queue_summaries.sql` before publishing `admin.html`. It adds the summary RPC and a partial account/newest-job index. The RPC checks `auth.uid()` against `dispatch_admins`, revokes anonymous/public execution and permits authenticated callers only after the explicit admin check. Its fixed search path and parameterized static SQL avoid caller-supplied SQL. It deliberately follows the explicit admin-checked definer pattern of existing admin RPCs.

The account list still uses existing Supabase RLS for account jobs and review details. No service-role key is placed in the browser.

## Validation

`node test-lazy-queue.js` uses local Chromium, the real queue/modal JavaScript and fake Supabase responses. It does not log in or write to production. It checks 47 distinct account IDs (including duplicate names and missing profiles), one summary request/no global job request, scoped lists, deferred profiles/credentials, search/status/SA-date filters, short-server-page pagination, action IDs, outcome/removal flows, fresh counts, initial/refresh/detail errors, races, escaping and mobile/desktop overflow.

Live database read-only checks validated all configured status counts, South African today boundaries, representative global searches and explicit unauthenticated/non-admin denial against the actual saved records. The overview returned 47 cards in an approximately 8 KB JSON response at validation, without downloading the 12,151 saved job rows to the browser.

Offline tests and direct database checks do not establish authenticated production page timings or confirm GitHub Pages deployment. Verify the published admin page separately. If rolling back the HTML, leaving this read-only RPC/index installed does not affect the previous page.
