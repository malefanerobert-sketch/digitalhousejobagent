# Account-first application queue

The Application queue opens with clickable account-name cards and filtered job counts. No mixed job list is rendered at the overview. Click a card to show only that account’s jobs; All accounts returns to the cards.

Grouping uses job_seeker_id, with the joined seeker ID as fallback—never display names or emails. Accounts sharing a name remain separate. Missing joined profiles retain separate groups when their seeker IDs are known.

Search and status filters work at both levels. Statistics scope to the selected account. Refresh, saved outcomes and queue removal retain the current account, including a scoped empty state when its last job is removed. Existing review/apply, outcome-saving and delete handlers are unchanged.

This is a frontend-only presentation change. No database records, application statuses, permissions, discovery rules or backend schema are changed. GitHub Pages deploys admin.html from main; no Railway redeploy is required.

Run `node test-admin-account-queue.js`. It uses local Chromium fixtures without credentials or external packages, checks desktop/mobile views and produces screenshots in an OS temporary directory. Override CHROMIUM_PATH if needed. It does not sign in, submit applications or alter live data.

## Fresh jobs across every account

Opening an account now performs a fresh server query filtered by its job_seeker_id, rather than relying only on the cached overview. The previous account-name lookup search is cleared on entry. Refresh inside a card reloads that account, and returning to overview cancels outstanding account loads. Existing application actions are unchanged.

The loader requests an exact row count, advances offsets by the actual number of returned records, and does not treat a short server-limited page as the end. It reads until the count is satisfied (or an empty page if no count is provided). Partial responses and concurrent duplicate-page gaps produce an error rather than silently replacing the list with incomplete data. A failed refresh retains the previous list with an explicit warning that it may be out of date.

Jobs are ordered by discovery time, newest first. Older user requests are no longer pinned over newer discoveries; their badges and dedicated status filter remain. The Today (SA time) date filter uses Africa/Johannesburg, including midnight boundaries, and works in both account cards and their job lists.

Run `node test-admin-queue-freshness.js` in addition to the browser regression. `account-sized-fixtures.json` contains only aggregate fixture sizes, not real profile details or job contents. It covers 47 account sizes, a 724-job large account, short 13-row server pages, fresh discoveries absent from cache, exact Today totals, missing count headers, failed partial responses and account-switch races. These are local regression fixtures, not authenticated browser sessions for the real accounts.
