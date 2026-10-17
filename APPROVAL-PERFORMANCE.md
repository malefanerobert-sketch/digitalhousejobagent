# Approval response optimization

Release: approval-fast-v1. No database functions, permissions, charges or balances were changed by this release.

## Findings
The click handler awaited the atomic `request_job_application` RPC, then rebuilt the entire matches grid both in its success branch and its finally branch. It also fetched the credit wallet again despite receiving the authoritative balance in the RPC response. The live database inspection found relevant match, profile, wallet and ledger indexes already present. No speculative new index or weaker authorization was introduced.

## Changes
- A shared `renderMatchCard` renders both normal lists and an individual updated card.
- Approval completion updates only its card, preserving unrelated DOM, focus, filters and selection.
- Normal success displays the returned balance without an extra wallet request.
- Failure and legacy responses missing a balance reconcile asynchronously; a slow balance refresh does not lock the retry button.
- Concurrent approvals share one final wallet reconciliation, preventing out-of-order responses from leaving a stale balance.
- Pending approvals abort an older periodic match refresh and defer new periodic refreshes until settled.
- Success and the existing sparks remain strictly server-confirmed. Duplicate clicks remain locked; server-side wallet locking and idempotent debiting are unchanged.

## Checks and limits
`node test-approval-speed.js` uses 850 synthetic matches, an isolated local Chromium instance and a mocked 120ms RPC, not a live authenticated Supabase call. It verifies no full-grid redraw, no normal-success wallet reread, preserved unrelated DOM/focus and confirmed-only success on desktop and mobile. Baseline measurements are local, machine-dependent browser timings, not production latency guarantees.

`node test-approval-concurrency.js` covers out-of-order responses, errors with a delayed wallet refresh, missing balance, skipped-job history, session changes, mixed success/zero-credit rejection and live-refresh deferral/abortion.

Existing `test-application-credits.js` and `test-staff-support.js` verify credits, double-click locking, retry/no-charge behavior, sparks, read-only staff support, session scoping and mobile layout. `validatePagesBuild.js` still excludes SQL/worker/test files from public Pages assets and preserves the 100-slot admin build.

Network, authentication and server processing time remain part of submission latency. No real applicant jobs were approved and no real tokens were spent for these tests.
