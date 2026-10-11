# Live match-list refresh

The applicant app refreshes saved matches and application records every 60 seconds while visible and signed in, and when the tab regains focus.

- Discovered and Skipped remain separate; their own counters reflect actual saved classifications. A new skipped job raises only the skipped counter.
- The refresh does not reload profile fields or reset current search/location filters and selected jobs.
- Fetches cannot overlap, use a 30-second abort deadline, stop on sign-out, and discard records fetched for a previous applicant.
- Transient errors retain the currently displayed results and retry on a later interval without recurring error toasts.
- Discovery schedules and application execution are unchanged. Refreshing counts is not the same as finding a new job each minute.

Run node test-live-refresh.js and the existing match/delete/application workflow regressions.
