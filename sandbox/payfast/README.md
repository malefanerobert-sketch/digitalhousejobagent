# JobAgent — PayFast Sandbox foundation

**Milestone 1, sandbox-only development harness. Not deployed, not production billing.**

This folder is intentionally separate from the existing application. It has **no Supabase connection, no real user accounts, no live PayFast endpoint and no production-wallet writes**. It uses a synthetic `sandbox-demo-only` wallet in a local SQLite database. No paid hosting or new cloud database is required to run automated tests.

The harness is an integration prototype, not a replacement for JobAgent authentication or the production credit RPC. Production architecture remains GitHub Pages + Supabase + Railway. The SQLite implementation is an executable reference for later transactional Supabase integration, not a proposed migration of production storage.

## Scope and status

Implemented locally:
- Fixed server-side catalog: R200/month = 600 monthly tokens; R50/R100/R150 = 100/200/300 purchased tokens. ZAR only.
- Signed Sandbox checkout, including initial subscription fields (`subscription_type=1`, `frequency=3`, `cycles=0`). No passphrase sent to the browser.
- Private, single-operator test UI with a separate random access key and HttpOnly, Secure, SameSite=Strict session cookie.
- Payment notification validation: signature, merchant, positive source-IP match against official PayFast DNS, expected amount/package/order, optional currency, and server-to-server Sandbox validation. One unavailable official hostname does not discard a positive match from another; an unmatched/indeterminate source remains fail-closed.
- Read-only `queryPaidTransaction` recovery helper binds an authenticated Sandbox API `COMPLETE` response to the exact stored order, provider payment ID and integer-cent amount. API recovery is audited distinctly from ITNs. A transaction token is never assumed to be a subscription token; subscription linkage can remain pending, and a later verified matching ITN can link it without granting twice.
- Atomic SQLite wallet + ledger + receipt updates; unique PayFast transaction IDs, immutable receipt binding and checkout request UUIDs.
- Zero starting test tokens. Initial verified subscription credits 600 monthly tokens. Top-ups credit only the separate purchased balance.
- Internal synthetic-wallet spending tests use monthly tokens first. Purchased tokens never expire; a due-date-based three-day grace permits spending, then freezes use without deleting either balance.
- Return/cancel browser redirects NEVER grant tokens. The app only trusts verified server notifications.
- HTTPS staging-origin guard rejects the production JobAgent domain and production Supabase/GitHub Pages origins. Fixed Sandbox processing and validation URLs; no `live` switch.
- No changes to `index.html`, `admin.html`, existing credit SQL/RPCs, Railway worker, production Pages workflow or public asset allowlist.

**Not implemented / not verified:**
- Actual Sandbox testing is now recorded in `VERIFICATION-2026-10-18.md`: the initial R200 payment was recovered through an authenticated provider API lookup; the R50 top-up passed via a genuine verified ITN. Offline automated tests still use synthetic DNS/provider responses and no user credentials.
- A temporary Cloudflare Quick Tunnel was used for the actual Sandbox test. It is not permanent hosting, has no uptime guarantee and stops if the development environment or tunnel process ends. No Railway service, paid hosting, DNS change or production deployment was created.
- No app-level Supabase authentication, RLS policies or migrations have been added/applied.
- **Renewals are deliberately held for review and do not grant/reset tokens.** ITN receipt time is not evidence of which anniversary period was paid. A cycle reconciliation adapter against authoritative provider subscription data is still required. Original-anniversary/no-rollover renewal allocation, reactivation, missed cycles and out-of-order renewals must be implemented and tested before billing is complete.
- Cancellation, refunds, disputes, failed-charge lifecycle notifications and customer payment-method changes are not implemented. Unknown/refund-like statuses fail closed; this is a live-launch blocker, not completed refund handling.
- The synthetic `spend` helper is test-only and not exposed as an HTTP endpoint. No real job approvals are connected.
- Yoco integration and recurring-method suitability are not implemented/verified.
- Robert's real account, all existing balances, and the current 600-token welcome allocation remain unchanged. Production exemption treatment must be explicitly implemented and tested before enforcement; it is not present in this prototype.

## Run offline tests now (no keys needed)

Use **Node.js 24 or later**. Node 24 provides the built-in SQLite API; no dependency install is needed.

```sh
cd sandbox/payfast
npm test
```

Tests cover signature encoding/order/empty values, exact amounts, notification forgery, wrong merchant/currency, source spoofing, DNS/provider failures, duplicate and out-of-order delivery, rollback after a forced ledger failure, receipts surviving multiple database connections, separate balances, monthly-first spending, month-end/leap-year date arithmetic, exact grace boundaries, top-up non-renewal, session access, CSRF origins, public-file allowlists and return-URL non-authority.

The new `payfast-sandbox-tests.yml` workflow only runs tests. It cannot deploy and receives no repository/payment secrets. The existing production workflow remains unchanged; do not manually dispatch it against this development branch.

## Local verification — 18 October 2026

- 59 Node tests passed locally, including the partial-DNS-failure regression and authenticated API recovery/idempotency tests.
- Syntax checks passed for the server and browser script.
- Local Chromium check passed: operator login, unpaid top-up gating, signed form capture, zero credit from checkout alone, server-confirmed synthetic wallet display, and desktop/mobile widths. Form submission was intercepted in the browser; no PayFast request was made. This browser check is not part of the dependency-free CI suite.
- Real Sandbox results are documented separately in `VERIFICATION-2026-10-18.md`; automatic renewals/recurring settlement and GitHub Actions results are not established by local tests.

## Later: run a hosted Sandbox checkout

Do not supply credentials in chat or commit them to GitHub. No credentials from screenshots are copied into this branch.

1. Create a dedicated HTTPS staging hostname/server, separate from the live JobAgent domain. Obtain explicit approval before buying hosting, changing DNS or creating paid services. PayFast ITNs cannot reach an unexposed localhost server.
2. On that isolated server, copy `.env.example` to `.env`. Keep `.env` owner-readable only (`chmod 600 .env`). Fill `SANDBOX_MERCHANT_ID`, `SANDBOX_MERCHANT_KEY` and `SANDBOX_PASSPHRASE` using your **Sandbox** dashboard, never live credentials. This harness requires an 8-128-character passphrase using letters, digits, hyphens, underscores, slashes or full stops. If a passphrase change is needed, update both Sandbox and the private environment together.
3. Generate a separate random operator access key with `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"` and save it privately as `SANDBOX_ACCESS_KEY`. This is a local test-tool login, not a PayFast password/key/passphrase.
4. Set `SANDBOX_PUBLIC_ORIGIN` to the dedicated HTTPS origin only, no path. The server binds to `127.0.0.1:8787` unless explicitly configured. Use an HTTPS reverse proxy and preserve the public Host/Origin.
5. If using a reverse proxy, set `SANDBOX_TRUSTED_PROXY_IPS` to its **exact** IP addresses. Configure it to append or overwrite `X-Forwarded-For` with the actual upstream client. The code walks the chain from the trusted end, rejects missing/invalid chains and never trusts forwarding headers from untrusted peers. No wildcard/CIDR trust is provided. Test genuine PayFast source-IP handling before claiming ITNs work.
6. Run `npm start`. Both checkout and provider validation URLs are hard-coded to `sandbox.payfast.co.za`. SQLite is created under ignored `var/` with restrictive file permissions. Protect and retain this directory: it contains test receipts and confidential subscription tokens, even though no live customer data is used. Do not put it in a public web root or use an ephemeral volume without understanding data loss.
7. Sign in through the staging page using the separate operator access key. Test the initial monthly subscription, wait for a verified notification, then test top-ups. The Sandbox uses a virtual wallet; it does not prove that any real card, bank payment method or 3D Secure flow works.
8. Check the test UI's verified payment history. A successful return redirect is not sufficient. A renewal or unexpected second payment is marked `review`, never automatically credited. Review items must be reconciled before any later automation.

The test UI keeps an uncertain checkout's request UUID in tab-scoped session storage and can recover a recent pending request from server state. A checkout retry is limited to one hour. If a stale request expires, inspect Sandbox Transactions/ITNs before intentionally starting a fresh request; the UI has no automated stale-request recovery or provider cancellation yet. Restarting the server signs out operator sessions but preserves SQLite receipts when the volume is persistent.

Only a synthetic account exists, so there is no production identity mapping or customer-facing multi-user security claim. The harness must not be exposed as a production customer portal.

## Private test access handoff

An authorized tester can receive a private link file with a `#test-access=` fragment instead of manually copying the operator key. The browser exchanges it only with the same-origin session endpoint, removes the fragment from the address bar/history before sending the request, and then uses the ordinary HttpOnly session cookie. URL fragments are not part of the HTTP request URL. This is a temporary test-only bearer link, not an account invitation system or production authentication feature.

Keep any such link/file private; never commit it, publish it or put it in a query parameter. Anyone with the complete link has the same synthetic test access. It expires when the temporary server/key is replaced. It cannot access live JobAgent accounts. Manual key input trims only surrounding whitespace.

Fresh-browser verification passed without pre-existing cookies, and the private fragment was cleared. No payment was made during that access check.

## Before production integration / launch

- Provision an explicitly authorized, isolated Supabase staging project and app preview. Do not restore real CVs, IDs, documents or customer data into it.
- Port audited ledger/receipt transactions to Supabase with owner/admin RLS, authenticated checkout ownership, service-only credit functions, idempotency and concurrency tests. Never grant browser wallet writes or publish service-role keys.
- Implement authoritative cycle reconciliation, monthly replacement rather than rollover, original billing anniversary with month-end and Johannesburg timezone rules, three-day grace, freeze/reactivation, cancellation, failure/retry handling and refunds/disputes. Purchased balances must not be erased.
- Confirm recurring payment methods separately from once-off methods (e.g. once-off Capitec Pay does not prove recurring support). Verify current provider fees, recurring activation, business verification and settlements.
- Connect user subscription/top-up UI without changing accepted token animations, staff read-only troubleshooting, job-approval behavior, private files or the public deployment allowlist.
- Define migration/exemption handling for existing users and Robert; do not remove welcome grants or reset balances silently.
- Complete terms, privacy, support and refund/cancellation policy requirements.
- Run actual Sandbox success/failure/retry/cancel/renewal/duplicate-ITN and notification recovery tests over HTTPS. Only then plan a separately approved live configuration and end-to-end verification.

## Official protocol references

- [PayFast custom integration, ITN verification, subscriptions and Sandbox](https://developers.payfast.co.za/docs/itn-instant-transaction-notification/)
- [Recurring subscription API](https://developers.payfast.co.za/api)
- [Signature mismatch / encoding guidance](https://support.payfast.help/portal/en/kb/articles/common-causes-of-a-failed-integration-signature-mismatch-20-9-2022)
- [Sandbox login](https://sandbox.payfast.co.za/)

PayFast's MD5 signature is implemented for protocol compatibility; it is not presented as a general-purpose modern signature standard. Network timeouts, DNS errors, mismatched data and invalid provider confirmation never grant tokens. Do not weaken checks to make a failing test notification pass.
