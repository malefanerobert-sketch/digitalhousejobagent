# Shared Groq vault: 100 optional slots

Admin → AI & Agent settings → Groq has K1–K100. Existing keys stay in their original slots. New slots are empty; no provider keys are generated. All slots share the selected model.

Apply `migration_groq_hundred_slots.sql` and deploy `groqKeyPool.js` with the existing `aiMatch.js` on Railway. `aiMatch.js` imports the pool size rather than hardcoding it. The migration preserves provider, model, legacy key, all existing slots and other settings; only the array length/default/constraint changes. Permissions are unchanged. Reload old admin tabs before saving: the exact-100 constraint deliberately rejects stale 20-slot payloads so they cannot clear K21–K100.

The worker retains provider cooldown/retry handling, invalid-key handling, duplicate-key shared cooldown and per-user overrides. This is key-management capacity, not a promise of 100× throughput: keys in one organization may share rate limits. Use authorized keys and provider-approved capacity. No concurrency, worker count or account quota is increased by this change.

Checks: `node test-groq-admin-slots.js`, `node test-groq-pool.js`; tests use fake keys and mocked provider requests, including K100-only use, all-slot wraparound and aiMatch completion/scoring from K100. No real credentials are needed or printed. Pages only publishes index.html, admin.html, supportAccess.js and build metadata; worker sources and SQL stay out of the public site.
