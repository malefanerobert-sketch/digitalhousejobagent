# Account-first application queue

The Application queue opens with clickable account-name cards and filtered job counts. No mixed job list is rendered at the overview. Click a card to show only that account’s jobs; All accounts returns to the cards.

Grouping uses job_seeker_id, with the joined seeker ID as fallback—never display names or emails. Accounts sharing a name remain separate. Missing joined profiles retain separate groups when their seeker IDs are known.

Search and status filters work at both levels. Statistics scope to the selected account. Refresh, saved outcomes and queue removal retain the current account, including a scoped empty state when its last job is removed. Existing review/apply, outcome-saving and delete handlers are unchanged.

This is a frontend-only presentation change. No database records, application statuses, permissions, discovery rules or backend schema are changed. GitHub Pages deploys admin.html from main; no Railway redeploy is required.

Run `node test-admin-account-queue.js`. It uses local Chromium fixtures without credentials or external packages, checks desktop/mobile views and produces screenshots in an OS temporary directory. Override CHROMIUM_PATH if needed. It does not sign in, submit applications or alter live data.
