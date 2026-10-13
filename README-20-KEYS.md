# Shared Groq vault: 20 slots

The current admin form and worker support K1–K20 with one shared model.
Empty slots are allowed. This extends the earlier ten-slot implementation.

## Deployment

1. Apply `migration_groq_twenty_slots.sql` after the original ten-slot migration.
   It appends ten null slots, preserves every saved key and model, and updates
   the default and exact-length constraint. It is safe to rerun.
2. Deploy `admin.html`, `aiMatch.js`, and `groqKeyPool.js`.
3. Refresh any open admin page before saving. An older cached ten-slot page
   will fail the new database constraint rather than silently erase K11–K20.
4. Enter additional keys privately in K11–K20 and Save. Do not commit keys.
5. Check worker startup logs for the `/20 slots configured` message.

Ready keys rotate; a 429 cools the affected key and switches to another ready
key using the same model. Duplicate copies share health state. Existing
provider timing, bounded waiting, invalid-key handling and personal overrides
are unchanged. Separate keys are not proof of separate provider quota.

## Tests

Run `node test-groq-pool.js`, `node test-scoring-route.js`, and
`node test-groq-admin-slots.js`.
These use fake keys and mocked providers; no real provider quota is consumed.
The UI save test verifies all twenty values reach the settings payload.

Database permissions are unchanged. Keep the vault restricted to authorised
admins and backend workers; this capacity change is not an access-control audit.