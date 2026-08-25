# DigitalHouse Job Agent — Worker

Background worker that discovers job postings and (for supported boards) submits
applications automatically. Connects to the isolated `digitalhouse-jobagent`
Supabase project — completely separate from DigitalHouse's main platform and
your school project.

## What's actually working right now

- **Discovery**: pulls live, real job listings from any company using
  **Greenhouse** or **Lever** as their careers platform, via those platforms'
  public JSON feeds (not scraping — this is data they publish for this purpose).
  Matches listings against each job seeker's keywords and saves matches to the
  `job_matches` table.
- **Apply on both Greenhouse and Lever**: opens the job page with a real
  headless browser, fills in name/email/phone, downloads the seeker's resume
  from its stored URL to a temp file and attaches it to the form, then
  submits — with random human-like delays between actions, and a clean stop
  (not a crash or a bad guess) if it hits a CAPTCHA or a form layout it
  doesn't recognize.

## What's NOT done yet — be aware of these gaps

1. **LinkedIn/Indeed aren't in Phase 1 at all.** These actively fight
   automation (CAPTCHAs, fingerprinting, login walls) — much higher effort and
   risk. Worth tackling only once the Greenhouse/Lever path is proven and
   generating real value.
2. **No user-facing dashboard yet.** Right now the only way to add a job
   seeker or approve a match is directly in the Supabase table editor. A real
   UI (matching your CRM's style) is a separate, follow-up build.
3. **CAPTCHA handling is "stop and flag," not "solve."** When the worker hits
   a CAPTCHA, it logs `captcha_blocked` and leaves the match as-is — a human
   needs to go apply manually for that one. This is the honest, safe default;
   auto-solving CAPTCHAs is its own can of worms best avoided.
4. **Custom application questions** (e.g. "Why do you want to work here?")
   that some Greenhouse/Lever boards add on top of the standard fields aren't
   filled in — the worker only handles the standard name/email/phone/resume
   fields. A board with extra required custom questions will currently fail
   with "could not find submit button" or submit an incomplete form,
   depending on the board — worth testing against a few real boards to see
   how common this is before relying on it heavily.
5. **Not tested against a live job board yet** — this code was written and
   syntax-checked, but hasn't been run against a real Greenhouse/Lever posting
   end-to-end. Treat the first few runs as a trial, not a guarantee — watch
   the `application_log` table closely at first.

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
4. Add at least one row to `job_sources`, e.g.:
   ```sql
   insert into job_sources (name, base_url, source_type, automation_risk)
   values ('Airbnb', 'airbnb', 'greenhouse', 'low');
   ```
   `base_url` here is just the company's Greenhouse board token — visible in
   their careers page URL, e.g. `boards.greenhouse.io/airbnb` → token is `airbnb`.
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
