# Optional applicant guidance

The strict-readiness deployment has been reverted at the applicant’s request.

- No real-information confirmation checkbox or new mandatory readiness checklist.
- Application requests do not call the readiness RPC or require applicant attestation.
- Profile completeness messages encourage adding details later, rather than blocking requests.
- The profile’s pre-existing basic required fields remain as before this readiness change.
- Discovery remains South Africa-only, with the existing US-feed freeze unchanged.
- Application automation remains disabled; requests use the existing admin queue.
- Employer-required factual answers, documents and actual submission receipts must not be invented.

`migration_application_readiness.sql` and its old rollback-test file are historical, superseded by `migration_optional_application_guidance.sql`. Existing unused confirmation metadata is preserved to avoid deleting applicant data; no active frontend or worker consumes it.

Run `node test-application-readiness.js` and `node test-admin-workflow.js` for current regressions.
