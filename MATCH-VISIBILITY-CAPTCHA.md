# Outcome-based Matches and CAPTCHA diagnostics

## User Matches
- Ordinary in-scope discoveries remain in the worker's pending queue, not in user Matches or its count.
- Applied and skipped outcomes appear in Matches.
- Outside-preference pending discoveries appear with an always-visible Apply button.
- That explicit Apply uses the existing approved queue status and bypasses preference/qualification guards. Blocked companies/locations, paused accounts and duplicate-terminal safeguards still apply.
- Explicitly queued jobs remain visibly Queued until their outcome; Queued is not Applied.
- All failed/manual/CAPTCHA/unverified outcomes remain in Application history and the admin Application Report. No history is deleted or automatically reset. Unverified submissions must be checked before any resubmission.
- Existing South Africa scope and location aliases are unchanged. All locations means no preference narrowing within this existing scope.

## CAPTCHA fixes
- Worker uses the solver's frame-aware detector, not a top-document generic CSS gate.
- Turnstile/hCaptcha are recognized before reCAPTCHA. reCAPTCHA iframe anchor keys are supported.
- Hidden generic captcha CSS classes alone are not treated as challenges.
- Correct owner frame is retained for delivery, including nested frames.
- A returned token alone is not a successful delivery: a genuine response field or callback must be reached; no disconnected document.body token is fabricated.
- Callback traversal is bounded and cycle-safe. No arbitrary global callback names are invoked.
- Already populated response fields prevent repeated solve charges within the same form.
- Provider failures distinguish missing key/package, zero balance, bad key, unsupported challenge, undeliverable token and unknown v3 action. No tokens or API keys are logged.
- Final submit rechecks CAPTCHA, including widgets that render after the initial page load. A CAPTCHA token is never application confirmation.
- v3 action and some managed challenge context cannot safely be guessed; those require manual/site-specific handling. Token delivery does not guarantee provider acceptance.

## Validation
Local fixture tests only: no paid solver calls, real employer submissions or automatic retries of uncertain applications.
Run `node test-match-captcha.js` and `node test-application-flow.js` with Playwright/Chromium available.
