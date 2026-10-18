# PayFast Sandbox verification — 18 October 2026

## Outcome

Actual provider testing, using virtual Sandbox funds only:

| Scenario | Actual observed result |
| --- | --- |
| Initial R200 monthly checkout | PayFast Sandbox API returned `COMPLETE`; exact stored order and 20,000 cents matched. |
| Initial notification | Rejected fail-closed due to a DNS-resolution bug in the documented source-host list. No speculative credit from redirect. |
| Subscription credit recovery | Authenticated, read-only Sandbox transaction query verified the original payment, then an atomic audited recovery credited exactly 600 monthly test tokens. No second subscription payment was submitted. |
| Same verified payment processed again | Duplicate recognized; monthly test tokens remained 600. This was an API-recovery replay, not a replayed HTTP ITN. |
| R50 top-up checkout | Actual Sandbox virtual payment completed for the 100-token package. |
| R50 notification | Genuine provider ITN passed signature, merchant, positive official source-IP match, amount/order checks and server-to-server Sandbox confirmation. It credited exactly 100 purchased test tokens. |
| Subscription unchanged by top-up | Monthly balance remained 600; stored due date remained 2026-11-18. |

**Final synthetic wallet: 600 monthly + 100 purchased = 700 spendable test tokens.**

This wallet is `sandbox-demo-only`, not Robert's account or any applicant account. The receipt ledger contains two credited provider payments, with the API-recovered subscription clearly distinguished from the ITN-credited top-up. No raw merchant credentials, passphrase, cookies, provider subscription token or signed webhook payload is included in this report.

## Fixes and safeguards

- The original implementation used `Promise.all` for all documented PayFast source hostnames. One hostname (`w2w.payfast.co.za`) did not resolve and caused every notification to fail with a retryable error even when another official hostname could positively identify its source.
- Source checks now tolerate a partial DNS failure **only when there is still a positive official IP match**. Unknown/unmatched sources remain rejected or retryable. Signature, expected merchant, amount/order binding and provider confirmation were not disabled.
- Authenticated API recovery uses the fixed Sandbox transaction-query endpoint and rejects pending/failed statuses, wrong orders, wrong payment IDs, wrong amounts and non-ZAR currency.
- API timestamps use an explicit ISO-8601 timezone offset. Response amounts are integer cents.
- A provider `transaction_token` is **not** silently repurposed as a recurring subscription token. The initial subscription's provider linkage remains pending. Later genuine matching ITNs can fill an absent subscription link without awarding tokens again.
- Temporary setup helpers kept the merchant passphrase in server memory, not in GitHub or a populated `.env` file. The original user attachment remains user-provided session material. Private test operational files and SQLite data are not part of this commit.

## Local automated checks

- 59 tests passed: protocol, source validation, transaction/ledger safety, request binding, sessions, origin checks, expiry/grace arithmetic, duplicate recovery and read-only provider reconciliation.
- The browser previously passed desktop/mobile checks. Actual provider checkout was performed separately from those mocked browser checks.
- GitHub Actions status has not been independently verified by this report.

## Production and remaining scope

No changes to GitHub `main`, live Pages assets, Railway services, DNS, live PayFast configuration, existing Supabase wallets or Robert's real account were made.

Still **not live-ready**:
- Automatic renewal credit/anniversary reconciliation, cancellation, failure/retry lifecycle, refunds and disputes.
- Recovery of the original subscription's provider linkage/notification, before claiming subscription administration or renewal behavior works.
- Real payment methods, 3D Secure, merchant approval/verification, settlements, live fees and live end-to-end testing.
- Actual Sandbox R100/R150 top-ups, provider cancellation flow and duplicate HTTP-ITN replay were not run in this session; their catalog rules/idempotency have local automated coverage only.
- Multi-user Supabase staging integration, owner/admin RLS and migration/exemption behavior for existing accounts.

The Cloudflare Quick Tunnel is a temporary development aid. Its process and URL can disappear; it is not permanent payment hosting. The committed source, automated tests and this verification record are the durable deliverables. No claim is made that every subscription lifecycle path is complete.
