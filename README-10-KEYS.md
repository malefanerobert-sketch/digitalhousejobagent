# JobAgent — 10 shared Groq API-key slots

This update adds a shared-company Groq key pool. It preserves the original admin page and adds exactly K1–K10 to its shared AI settings when Groq is selected. Empty slots are allowed. All slots use one shared model dropdown; the default is `openai/gpt-oss-20b`. Groq model availability is checked on settings load and through **Refresh Groq models**. The fallback list contains only chat models confirmed available when this fix was prepared; availability can change.

## Install
1. Back up `admin.html` and `aiMatch.js` and review the changes.
2. In Supabase, review existing `dispatch_settings` RLS policies and column grants. Ensure anonymous visitors and ordinary users cannot read shared API-key columns. This migration preserves existing access; it does not verify or fix it. Keep the worker's service-role credentials on Railway, never in browser code.
3. Run `migration_groq_key_slots.sql` in the Supabase SQL Editor. It creates a 10-element JSON array and cooldown setting and migrates the old shared Groq key to K1 when appropriate.
4. Replace repository `admin.html`, `aiMatch.js`, and `discoverAuto.js`, and add `groqKeyPool.js` alongside `aiMatch.js`. Redeploy GitHub Pages and Railway. No package dependency changes are required (Node 18+ built-in fetch).
5. Open Admin → AI & Agent Settings → choose Groq. Enter keys in any of the 10 slots, select a model, and Save. Existing per-user AI overrides and other providers remain single-key and do not borrow company keys.

Replacing only admin.html does NOT enable automatic worker rotation. Deploy the worker files and SQL too. `discoverWatched.js` and `apply.js` already use `aiMatch`; autonomous scoring in `discoverAuto.js` now uses it too, so all shared Groq calls use one worker-process pool.

## Rotation behavior
- Ready keys rotate round-robin on successive shared-company Groq requests, matching the fixed workbench behavior.
- On HTTP 429: cool the limited key and retry the same prompt using another ready key, keeping exactly the same selected model.
- Use Groq retry-after, exhausted-quota reset headers, or an error-message retry duration when available; otherwise use the saved cooldown (default 60 seconds).
- Duplicate copies of the same key share cooldown and invalid status.
- HTTP 401 marks a key invalid until replaced or the worker process restarts. Server/network errors temporarily cool a key and fail over with bounded retries. Bad prompts, wrong models, and permission errors are not endlessly retried.
- If all keys cool down, an individual call waits up to 90 seconds total for a ready key. Longer cooldowns return to JobAgent's existing null/keyword fallback rather than stall a whole discovery/application run. Later calls try again after cooldown expiration. Each network request also has a 45-second timeout.
- Cooldown tracking is in worker-process memory and survives settings refreshes for unchanged keys, not worker restarts. Separate Railway processes do not coordinate their cooldowns.
- The admin vault shows configuration only, not live worker cooldown countdowns.
- Ten keys do not multiply your Groq quota. Keys within the same organization may share limits.

## Testing
Run `node test-groq-pool.js` and `node test-scoring-route.js` from this folder. Tests use fake keys and mock API responses; no real AI requests are made.

Run the migration before deploying the code. Confirm GitHub Pages and Railway have deployed the commit, and verify the startup log reports "shared Groq vault" and "rotation enabled". Live key validity must be checked with Groq; the included tests use mocked responses.

## Model-availability fix
The uploaded worker logs showed repeated Groq 404 responses for `llama-3.1-8b-instant`. Groq's live model list did not include that model. The shared model was switched to `openai/gpt-oss-20b`; all seven configured slots passed individual live completion probes with it. This does not imply an actual live rate-limit event was induced; rate-limit rotation remains tested with mock responses. OSS requests use low reasoning effort, hide reasoning output, and reserve at least 2048 completion tokens so short scoring budgets do not leave empty answers. The 404 job-board URLs in the logs are separate from Groq model failures.
