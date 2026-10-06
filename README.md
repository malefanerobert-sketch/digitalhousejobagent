# DigitalHouse Job Agent — Worker

Background worker that discovers job postings and (for supported boards) submits
applications automatically. Connects to the isolated `digitalhouse-jobagent`
Supabase project — completely separate from DigitalHouse's main platform and
your school project.

## What's actually working right now

- **Discovery (South Africa)**: pulls live SA job listings from Adzuna ZA (the
  official Adzuna API), RemoteOK and Jobmail, plus any SA company or job-board
  page a user adds as a **Watched page**. Matches listings against each job
  seeker's keywords and saves matches to the `job_matches` table.
- **Apply**: opens the posting with a real headless browser, reads whatever
  form is on the page, fills in name/email/phone and attaches the seeker's
  resume, then submits — with random human-like delays, and a clean stop (not
  a crash) if it hits a login wall, a CAPTCHA it can't solve, or a layout it
  can't make sense of. Sites that gate jobs behind an account are handled via
  Watched pages with a stored admin login (one account per site, reused for
  every seeker).

## What's NOT done yet — be aware of these gaps

1. **LinkedIn/Indeed aren't supported.** These actively fight automation
   (CAPTCHAs, fingerprinting, login walls) — much higher effort and risk.
2. **Pure aggregator links often can't be auto-applied.** Adzuna's website is
   WAF-protected and its listings are only pointers to the employer's real
   site, so many Adzuna/Jobmail postings can be *discovered* but not
   auto-applied — they land in the report as "needs manual action" for the
   seeker to finish. Watched pages (with a stored login where needed) are the
   reliable way to actually apply on SA sites.
3. **CAPTCHA solving depends on 2Captcha + balance.** With `CAPTCHA_API_KEY`
   set and funded, the worker solves reCAPTCHA/hCaptcha/Turnstile. It cannot
   bypass a CloudFront/WAF block or a login wall — those still stop and flag.
4. **Custom application questions** (e.g. "Why do you want to work here?") on
   top of the standard fields aren't filled in — the worker handles the
   standard name/email/phone/resume fields. A posting with extra required
   custom questions can fail or submit an incomplete form.

## Optional: smarter matching with your Anthropic API key

By default, matching is done with simple keyword overlap between the job
seeker's keywords and the job title/description — no AI, no API key needed,
works fine on its own.

If you add `ANTHROPIC_API_KEY` to `.env`, the worker upgrades to AI-scored
matching: any job that clears the cheap keyword pre-filter gets sent to
Claude along with the seeker's resume text, which judges real fit (not just
word overlap) and returns a score plus a one-line reason — stored in
`job_matches.match_reason` so you can see *why* it matched when reviewing.

If the API call fails for any reason (rate limit, network issue, bad key),
the worker logs the error and falls back to the keyword score for that job
rather than stopping the whole run — matching never hard-fails because of AI.

This only affects `discover.js` (deciding what counts as a match) — it does
not touch the actual form-filling/submission logic in `apply.js`.

## Setup

1. Install Node.js (same LTS installer from nodejs.org you already grabbed)
2. In this folder, run:
   ```
   npm install
   npx playwright install chromium
   ```
3. Copy `.env.example` to `.env` and fill in the Supabase service role key
   (find it in the Supabase dashboard → Project Settings → API → service_role
   key — keep this secret, never put it in a frontend file)
4. Discovery sources are the SA feeds already seeded in `job_sources`
   (Adzuna ZA, RemoteOK, Jobmail). To auto-apply on SA sites that require a
   login, add the company/job-board page as a **Watched page** in the app and
   store the admin login there — the agent reuses that one account for every
   seeker.
5. Add at least one row to `job_seekers` with real keywords and the dedicated
   application email.
6. Test manually first:
   ```
   npm run discover
   ```
   Check the `job_matches` table in Supabase to see what it found.
7. Once discovery looks right, test apply mode (start with ONE seeker in
   `approval` mode, manually set one match's status to `approved` in the
   table, then):
   ```
   npm run apply
   ```

## Making it actually run 24/7

`index.js` is the always-on process — but your own PC being on isn't a real
"24/7" solution (it'll stop the moment you shut down or lose internet). To
make this genuinely live, it needs to run on a host that keeps a Node process
alive continuously. A few realistic, low-cost options:

- **Railway** or **Render** — both have a free/cheap tier, deploy straight
  from a GitHub repo, keep a Node process running continuously. Easiest
  starting point.
- **A small VPS** (DigitalOcean, Hetzner, etc.) — a few dollars a month, full
  control, run `node index.js` inside a process manager like `pm2` so it
  restarts if it crashes.

This will **not** work on Netlify Functions or Supabase Edge Functions — both
are serverless and shut down between requests, which is the opposite of what
a 24-hour background worker needs.

## Safety notes worth keeping in mind

- Applications are submitted with deliberate randomized delays
  (`MIN_ACTION_DELAY_MS` / `MAX_ACTION_DELAY_MS` in `.env`) to avoid looking
  like a bot hammering a site instantly — don't remove these.
- `MAX_APPLICATIONS_PER_RUN` caps how much the worker does in one pass, as a
  safety brake against runaway behavior if something goes wrong in matching
  logic.
- The dedicated-email idea protects the user's main inbox/identity, but
  doesn't by itself prevent detection — sites also fingerprint browser
  behavior. Keep expectations realistic with users: this is "best effort,"
  not guaranteed undetectable.
