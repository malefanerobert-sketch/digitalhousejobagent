# Discovery ingestion recovery

## Incident evidence

The uploaded Railway log excerpt (2026-10-15 02:00–03:08 UTC) contains Chromium headless-shell launch failure with SIGTRAP, repeated full-advert capture failures, 15 deferral summaries totalling 476 candidate attempts (not unique vacancies), Groq cooldown fallback messages and Adzuna HTTP 503 errors. No successful match save appears in that excerpt.

The future-only completeness gate prevented incomplete captures from being published, but the earlier implementation did not durably preserve those rejected candidates. This update corrects that omission. It does not guarantee that inaccessible publisher pages can be retrieved.

## Changes

- Prefer Playwright full Chromium (`channel: chromium`); fall back to its default runtime if needed. `CHROMIUM_PATH` can explicitly select an installed compatible binary.
- Reuse one browser for feed/retry detail extraction and serialize detail captures; avoid launching a fresh browser per vacancy. Watched discovery has its own browser, closed in a finally block.
- Report useful redacted browser startup diagnostics. A 60-second launch cooldown avoids repeated failed process spawns. Failed detail captures are cached for only one minute; complete captures for 15 minutes.
- Run a startup browser smoke check. A failed check is prominently logged but does not prevent autonomous feed discovery from preserving candidates.
- Preserve new incomplete candidates in `job_discovery_candidates`. This is not a Matches table and has no anon/authenticated read grants or policies. Only the server-side service role can use it.
- Retry due candidates every five minutes (bounded to eight distinct URLs from up to 200 due rows per pass). Per-row atomic 15-minute leases and exponential retry delays (five minutes to six hours) prevent tight loops. In-process overlapping discovery/retry runs are skipped.
- Publish only after the existing complete-advert gate passes. Do not invent salary, employer or qualifications. Existing matches and applicant/admin decisions are not updated. Historical repair remains off unless explicitly enabled.
- Recheck account/source enablement and block lists; deduplicate against existing matches. Retry processing does not require another Groq call, although initial discovery/scoring still uses the existing providers.

## Deployment order

1. Apply `migration_job_discovery_candidates.sql` to Supabase.
2. Deploy this commit to the Railway worker. Build must install full Chromium and its dependencies; existing Railway/Nixpacks build commands retain that install step.
3. Check deployment logs for `[browser-healthcheck] PASS` and `[job-browser] Started full Chromium`. If both browser launch modes fail, the cause of the runtime's SIGTRAP still requires Railway-level investigation; do not call the incident resolved.
4. Confirm `[candidate-queue] Preserved ...` during failures and `published ... complete new match(es)` after successful retries, plus fresh `job_matches.discovered_at` values in Supabase.
5. Validate Robert and another account in the authenticated admin UI. A GitHub commit alone is not proof that Railway or GitHub Pages deployed it.

Already deferred attempts from the uploaded logs cannot be recovered from those log messages alone: they do not include sufficient vacancy URLs. They need rediscovery; the new durable queue protects candidates discovered after this deployment.

## Local regression tests

`node test-ingestion-recovery.js` covers browser preference/fallback/cooldown/shared launch using injected engines; durable holding, failed captures/writes, retry backoff, complete-only publication, existing status preservation, account/source controls, block lists, country evidence, overlap and bounded work using an in-memory database.

`node test-future-publication.js` checks publication gates on both discovery paths and historical repair remaining off by default.

These tests do not launch Railway's actual Playwright binary, access real publisher pages, or prove production recovery. The startup smoke check and subsequent fresh database saves are required production evidence.
