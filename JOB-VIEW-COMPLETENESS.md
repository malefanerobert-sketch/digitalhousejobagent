# Complete applicant job view

The job modal now re-reads the selected match's latest saved advert, scoped to the signed-in seeker. This replaces stale in-tab summaries when the worker has already saved fuller details. The browser does not request the source URL. Late responses cannot overwrite a different job or reopen a closed modal. If reloading fails, the saved in-tab details remain visible.

Published employer information, introductions, benefits, duties, qualifications, experience, salary, working arrangements, required documents and closing dates are retained. Unknown subheadings inside job sections do not impose a preview cutoff. Source branding and links remain filtered from applicant display; application routing stays in the backend/admin records. This is display privacy, not a new column-level access policy.

Extraction preserves salary, qualifications, education, experience and benefits supplied as separate structured fields even when a longer visible advert container is selected. Structured credential categories and month-based experience requirements are supported. The hiring employer can also be recovered from the corresponding structured posting.

No salary or requirement is invented. An expired, blocked or inaccessible source can still leave only a summary. The versioned background retry pass retrieves missing adverts; opening the modal reloads saved data, not a new source scrape.

Run:

```sh
node test-complete-job-view.js
node test-scoped-details.js
node test-job-details.js
```

Set `CHROMIUM_PATH` for the new test if Chromium is not at `/usr/local/bin/chromium`. Its desktop/mobile screenshots use the OS temp directory, or `JOB_VIEW_SCREENSHOT_DIR` when supplied. Tests use local intercepted fixtures, not real application submissions.

## Whole-pipeline coverage

- Autonomous feeds and watched pages both use `storedJobDetails` after the shared full-advert extractor. A failed short extraction cannot displace a longer available feed, and a feed fallback is labelled limited, not captured. Provider labels cannot become the employer.
- Legacy AI advert-cleanup functions with 7,000-character input and 8,000-character output cutoffs have been removed. Employer-identification prompts remain separate from advert content.
- Structured JobPosting objects nested inside WebPage/mainEntity and other object fields are recognised. Concurrent captures of the same normalised vacancy URL share one in-process task.
- `migration_job_detail_capture_version.sql` must be applied before deploying the Node worker. Existing records default to version 0 and become repair candidates, including old captured records and null statuses. New extraction is version 2.
- Repair paginates up to 2,000 candidate records per pass to find up to eight distinct adverts, rather than stopping at one applicant-copy cluster. It excludes watched-page error notices. It updates each applicant copy independently and preserves richer saved content on shorter results or retrieval failure. It does not alter application status, eligibility, match identity or discovery time.
- `index.js` schedules a bounded repair pass at startup and every 15 minutes (`DETAILS_CRON` can override this), independent of new-job discovery and subject to the existing master switch. Failed/limited adverts wait at least six hours between repair attempts. Both discovery paths can also request a pass; in-process overlap is shared.
- Tracking-only query parameters share retrieval work; persisted copies with differing exact URLs may be updated on later passes from that cache. No source application forms are submitted by extraction.

Additional regression test:

```sh
node test-detail-pipeline.js
```

The database migration has been applied to the connected project. GitHub Pages is configured to deploy frontend changes pushed to `main`. The Node worker must also deploy this commit (Railway's configured `node index.js` service); a Pages deployment alone cannot activate server-side extraction and repair. The connected tools do not expose Railway deployment status.
