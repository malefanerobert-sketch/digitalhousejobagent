# Strict application readiness

## What changed
- `get_application_readiness` is a permission-checked server-side readiness calculation, not a client-side completeness percentage.
- Applicants see a missing-information checklist in Dashboard and Profile. Discovery and the permanent match archive continue while they complete it.
- `request_job_application` rejects an incomplete or unconfirmed profile before changing queue status. Changing HTML or calling the RPC directly does not bypass this check.
- `confirm_application_profile` requires the applicant's own authenticated account and verifies the saved factual fields/history. The confirmation is bound to a fingerprint of that profile, employment/education/references and document pack. Changes make the old confirmation unusable until reconfirmed.
- Direct authenticated updates to the confirmation fields are rejected by a trigger. Internal snapshot/validation functions are not executable by anonymous or ordinary authenticated clients.
- The retained application loop fails closed on the same backend readiness check. **The application runner remains disabled and Railway remains discovery-only.** This change does not enable automatic submissions or email sending.
- The admin application modal displays the backend missing-information list and watched-source application notes, including saved email route instructions even without login credentials.

## Basic readiness
Genuine full name, valid-format email/phone, ID type and number (SA IDs checked for length/checksum; passports for basic format), actual DOB/gender/nationality, an explicit answer about right to work in South Africa, address/current city/province/postal code, availability, years of experience, truthful dated employment history when employed, education history when a formal qualification is claimed, skills/languages and job preferences/application scope.

A real uploaded HTTPS CV can be used, or a complete confirmed profile with a genuine bio can generate a CV. Empty, unsupported, oversized and demo/test CV uploads are rejected by the UI. Format checks and an applicant attestation are **not** independent identity, document authenticity, work eligibility or email ownership verification.

Zero work experience and No formal qualification are valid explicit answers. The gate does not assume South African citizenship. Applicants outside South Africa can state that location truthfully; jobs remain ZA-only and employer eligibility is checked separately.

Photographs, ID copies, payslips, certificates, reference counts, race/medical/criminal declarations and candidate account access remain employer-specific requirements. Basic readiness does not guarantee a complete application on every site; the agent must never invent these answers or manufacture documents.

## Deployment and tests
Apply `migration_application_readiness.sql` before the HTML/worker deployment. Existing profiles and all discovered jobs/application histories are preserved. Existing profiles start unconfirmed; they are not silently certified from test data.

- `node test-application-readiness.js`: mocked frontend checklist, readiness queue blocking, confirmed path, editing resets checkbox, unavailable checks fail closed.
- `node test-admin-workflow.js`: existing permanent-discovery, skipped, applied and manual-admin workflow regressions; no real applications.
- `test_readiness_database.sql`: rollback-only backend tests for incomplete queue rejection, profile-generated CV readiness, confirmation invalidation by profile/doc edits, dates/placeholders, protected confirmation and cross-applicant access. All fixture changes are rolled back.
