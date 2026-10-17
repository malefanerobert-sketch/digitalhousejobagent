# Approved-only admin Application queue

Only matches with `admin_application_requested_at IS NOT NULL` belong in the admin Application queue. This field is written by the existing authenticated, ownership-checked `request_job_application` approval RPC. Status alone is not treated as approval provenance.

- Server account summaries restrict their base rows before status/date/search/count/grouping.
- Per-account lists and on-demand review queries use the same non-null predicate.
- Rendering also rejects unrequested rows, including stale or unexpected payloads.
- Existing user-requested jobs retain visibility after an admin outcome; the default Open work view excludes completed applications while All user-approved jobs includes their history.
- Unrequested discoveries/manual-action records do not appear even in All or search. They remain stored and available in the user app; no match rows, credit balances or application records were changed.
- Legacy completed or manual-action records without a recorded user request are excluded intentionally. No approval timestamps were backfilled.

Supabase migration: admin_queue_only_user_approved (migration_admin_approved_queue.sql).
Public release: admin-approved-queue-v1.

Checks: live SQL assertions compare all counts/account groups/every status filter to the request-only predicate, and verify non-admin/unsigned denial. Offline real-HTML Chromium tests exercise unapproved status variants, account isolation, search, filters, fresh approval entry, retained admin outcomes, capped pagination, stale responses, documents and token flows. No real application submission or token spend performed by tests.
