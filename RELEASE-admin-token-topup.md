# Manual admin token top-ups

Release `admin-token-topup-v1` adds **Accounts → Top up tokens** to each account in the admin app. It loads that account's authoritative wallet balance; authorized staff enter a positive whole token amount and a reference, then confirm the addition. No payment gateway is connected and no payment is taken.

## Database
- `admin_get_application_credit_balance(uuid)` checks `dispatch_admins` membership and resolves the selected seeker to its auth user server-side.
- `admin_top_up_application_credits(uuid,integer,text,uuid)` makes an additive credit under the same wallet row lock used by approval spending, atomically inserts a ledger receipt, and returns the confirmed balance.
- Valid top-up: 1–1,000,000 tokens; reference length 3–500; integer balance overflow rejected.
- Ledger metadata: `admin_actor_id`, `admin_request_id`, `admin_note`. New `admin_topup` reason is constrained to positive amounts, a null match, and mandatory audit metadata. Existing welcome600 and approval−1 rules preserved.
- Unique request UUID protects retries. Replay validates target user, staff actor, amount and normalized reference, returns the existing receipt without adding again, and reads the current wallet balance.
- No new table write grants, no new wallet or ledger RLS policies. Unauthenticated/non-admin callers cannot top up. Existing owner/admin read rules remain.
- Zero-token approval message now directs users to support for a top-up; approval/debit logic unchanged.

## Browser
The form confirms the named account before submission, locks in-flight writes, and only displays success after a valid server receipt. Ambiguous responses preserve an immutable request payload in staff/account-scoped session storage; retrying or reopening the form in the same tab reuses the original request UUID. Pending drafts last for that browser tab's session; closing the tab discards the client draft. Do not initiate a separate top-up after an uncertain result without checking the recorded ledger. Reference text should contain operational references, not passwords, card numbers or document contents.

The user app's existing balance refresh will pick up the new total on its next successful refresh or reload. No user UI, two-second fireworks or approval speed logic changed, other than matched build/version references. Approved-only admin queue, applicant document access and the 100 Groq slots retained.

## Verification
- Live SQL used synthetic auth users, staff membership and generated wallets, entirely inside a rolled-back transaction: welcome600, additive125, exactly-once retry, audit actor/reference/amount, payload mismatch, invalid amounts/reference, missing account, non-admin and unsigned denial, direct-write denial, owner-visible balance, other-wallet isolation and overflow rollback. No real account was credited.
- Offline real-HTML Chromium: per-account controls, actual mocked balance, validation/confirmation, duplicate clicks, slow writes, ambiguous post-commit network response, preserved retry after reopen, errors, malformed replies, stale responses and responsive desktop/320/390 layouts.
- Existing queue/docs/staff/credits/motion suites remain passing.

Migrations: `admin_token_topups`, `admin_topup_support_message`.
