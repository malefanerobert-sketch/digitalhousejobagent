# Application flow correction

- Adzuna advert pages are navigated through their visible Apply link before any applicant data is filled. Missing links and redirect loops are manual-review outcomes, not successes.
- Application fields prefer the active application form over newsletter forms. Hidden, disabled, and stale controls are not blindly filled; actual hidden upload inputs are permitted inside a visible form. Frames and popup application tabs are supported.
- Review/Next/Continue are steps, not final submission. Required fields, selects, radio groups, consent controls and resume uploads must be satisfied before proceeding; unknown candidate facts are not fabricated. Employer login/OTP requirements remain human handoffs.
- Failed click actions are no longer swallowed. An uncertain submit is logged as submission_unverified and is not automatically resubmitted.
- Confirmation requires a new explicit receipt on the application site, not pre-existing wording or instructions on an Adzuna advert. References require an explicit reference-number label.
- Application runs are serialized within the worker process. This is not a distributed lock for multiple Railway replicas; use one applying-worker replica. Existing eligibility and terminal-outcome checks are preserved.
- Application log/status write errors are reported, not silently ignored.
- The user application history shows failed/uncertain attempts with notes and an Evidence action, and does not count unsupported historical success labels as confirmed submissions.

## Testing
`node test-application-flow.js` uses Playwright and local HTTP fixtures only. It does not contact employers, use saved applicant credentials, or send real applications. Set CHROMIUM_PATH if needed. Uses the existing Playwright dependency; no production dependency changes are needed.

No uncertain application is requeued by this code change. CAPTCHA, account login, required facts not on the profile, and non-standard portals can still require a human.
