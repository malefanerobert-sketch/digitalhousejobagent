# Application credits — initial release

## User behavior
- Compact, non-clickable gear indicator shows only the authoritative token balance, with its text centered within the box in the sidebar footer below Contact us and immediately above On watch and Sign out. On mobile it is inside the More/menu drawer. There is no token pop-up, explanatory copy or subtitle. The blue action reads only Approve, without a play icon or price label. It is not in Dashboard content or floating over matches.
- One token is charged when an applicant successfully approves a job for the admin queue. Viewing and discovery remain free. Approval is not a confirmed application or job offer.
- Approval feedback is now a slightly larger red/gold firework-style radial burst of sparks with a smaller 11px regular-weight (not bold) “−1 token” phrase drifting upward, lasting ~8 seconds with cleanup at 8.2 seconds. The phrase is plain text without a badge, card, border, emoji, large flame or flame glow. Particles are slightly larger (4 × 9 pixels), with a modestly wider burst. The separate success notice only confirms that the approval was queued; it does not display a token debit box. Reduced-motion users do not see the burst; their balance and success notification still update. The effect and debit phrase only appear after the server confirms a new one-token charge, never on failed or duplicate requests.
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
- Pages build/public asset validator and postdeployment manifest checks retained. Release marker: `approval-fireworks-v3`.
