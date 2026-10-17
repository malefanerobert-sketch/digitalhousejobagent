# Discovery eligibility — empty signup protection

Applied database migration: `discovery_profile_eligibility`, version `20261017213540`.

A signup profile is created immediately, but is not discovery-ready merely because its status defaults to active. Both autonomous and watched discovery, and durable candidate retries, must use `isDiscoveryProfileReady` before personalised capture, scoring or publication.

The rule uses the existing profile form requirements: full name, date of birth, gender, ID type/number, nationality and primary phone; at least one existing qualification and experience-range selection; and a non-blank target job role for personalised matching. It does not introduce any new form, checkbox, attestation, compulsory uploaded CV, employment history or paid subscription rule. A completed profile itself can serve as CV information.

A database BEFORE INSERT guard on `job_matches` enforces the same rule even for an old worker deployment or a profile cleared after worker selection. It locks the profile for the publication transaction and rejects an unready insert. Existing match updates, histories, wallets and profile data are not changed. No accounts are hard-coded or exempted. RLS and applicant/staff permissions are unchanged.

Verified live: Robert's existing profile is eligible without a resume URL. The empty new test account is not eligible. Its 25 already-created matches were retained, not deleted or hidden by this fix.

Tests: `node test-discovery-eligibility.js`, `node test-ingestion-recovery.js`, `node test-future-publication.js`, `node test-za-scope.js`. `test_discovery_eligibility_database.sql` creates temporary synthetic profiles/matches in a rolled-back transaction, checks real insert rejection, profile-only eligibility, missing fields, blank roles, cleared-profile rechecks, existing-history preservation and least-privilege function grants. All fixtures are rolled back; no real user data is modified.

Deploy this source to the Railway worker to avoid wasted capture/scoring. The live database guard already prevents new unready matches regardless of worker deployment state. This migration does not repair or remove existing matches and does not change profile UI, credit rules or admin application approval.
