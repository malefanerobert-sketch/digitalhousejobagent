# Application credits — initial release

## User behavior
- Compact, non-clickable sidebar indicator shows the authoritative token balance in green (#34d399), 14px regular weight. The gear sits 6px beside the number, with the pair centered in the card below Contact us and above On watch / Sign out. On mobile it is in the More/menu drawer. There is no popup, subtitle or floating balance card; Approve remains plain.
- One token is charged when an applicant successfully approves a job for the admin queue. Viewing and discovery remain free. Approval is not a confirmed application or job offer.
- Approval feedback is a red/gold firework spark burst with only a small 10px regular-weight pale-gold “−1 token” phrase drifting gently upward/left. The animated “Successfully submitted” phrase is removed. No box, badge, emoji or large flame. Sparks last about eight seconds and clean up at 8.2 seconds. Feedback appears only after a server-confirmed new one-token charge, never on failed/duplicate requests; reduced-motion users do not see the effect. The ordinary “Approval queued” status notice remains.
- Every auth identity receives 600 welcome tokens. Existing identities received the same one-time launch grant. Old requests are not charged retroactively.
- Retries/repeated clicks on the same match never debit again. An already queued legacy match remains free to retry. Zero tokens prevents a new approval, but not viewing matches.
- Staff support mode can read the selected user's balance; it remains read-only and keeps the staff identity.
- Online payment/top-ups are NOT implemented; no payment details are collected.

## Server model
Apply `migration_application_credits.sql` once via Supabase migrations.
- `application_credit_wallets`: one nonnegative balance per `auth.users.id`, not per editable/deletable seeker profile.
- `application_credit_ledger`: one welcome grant, unique user/match debit entries, balance snapshots and timestamps. Match deletion nulls the reference but does not refund or reset the wallet.
- Auth signup trigger creates the wallet and welcome entry in the signup transaction.
- `request_job_application(uuid)` retains ownership, active-account, block and uncertain-submission checks. It locks the match, then wallet, debits and queues in one database transaction. Wallet locks serialize approvals for different jobs/tabs; match locks and unique ledger keys deduplicate retries.
- Existing direct-status guard continues blocking browser approval updates outside the RPC. Existing trusted admin/service actions are unchanged; they do not charge an applicant merely for processing a queue entry.
- Authenticated clients have SELECT only on wallets/ledger, owner or authorized-admin RLS. No browser mint, reset, ledger edit or balance-update endpoint exists. Anonymous execution of the approval RPC is revoked.
- Do not expose service-role keys to the browser. Later paid top-ups need a separate authenticated checkout and server-verified, idempotent payment webhook; this release has neither.

## Verification
- `test-credits-db.sql`: real PostgreSQL tests using temporary auth accounts and matches in a transaction; all fixtures rolled back. Covers signup, wallet writes denied, RLS/cross-account/anonymous rejection, duplicate requests, zero balance, blocked company, legacy jobs, direct-status bypass, profile saves and recreation.
- `node test-application-credits.js`: actual HTML in offline Chromium, mocked network only; desktop/mobile, success/failure, in-flight duplicate click, retry, zero, spark removal, reduced motion, display-only indicator, plain approval labels and viewport checks.
- `node test-staff-support.js`: existing staff authorization/read-only suite plus target-wallet scoping.
- `node test-lazy-queue.js`: admin queue regression.
- `PUBLIC_SITE_DIR=/path/to/_site node test-application-credits.js` and staff suite validate the actual deploy bundle.
- Pages build/public asset validator and postdeployment manifest checks retained. Release marker: `approval-fireworks-v7`.
