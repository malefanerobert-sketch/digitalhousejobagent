require('dotenv').config();
// Stealth-wrapped chromium (see apply.js for the full rationale) — this file
// also drives a real browser against arbitrary third-party pages, so it
// should get the same anti-detection benefit, with the same safe fallback.
let chromium;
try {
  const extra = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  extra.chromium.use(StealthPlugin());
  chromium = extra.chromium;
} catch (err) {
  console.warn('[discoverWatched] stealth browser unavailable, falling back to plain Playwright:', err.message);
  chromium = require('playwright').chromium;
}
const supabase = require('./supabaseClient');
const aiMatch = require('./aiMatch');
const jobFit = require('./jobFit');

// Handles job_custom_sources — company/job-board pages a user has added
// themselves ("Watched pages" in the app). This is now the ONLY discovery
// mechanism in the product (the old job_sources/Greenhouse-Lever catalog
// approach has been retired) — the Agent visits each watched page itself,
// works out what jobs are posted there, and hands them to apply.js.
//
// Unlike a structured ATS feed, a watched page can be anything — a simple
// static company careers page or a heavy JS-rendered job board — so this
// uses a real browser (the same Playwright engine apply.js uses to submit
// applications) to render the page fully before reading it, rather than a
// plain fetch() that would see nothing on a JS-only site. It then hands a
// clean list of "link text + URL" pairs to the AI rather than raw HTML —
// smaller, cheaper, and immune to markup bloat burying the real content.

const MAX_LINKS = 600; // hard cap on links considered per page
const LINKS_PER_CHUNK = 150; // links per AI extraction call — keeps each
// request (and its JSON response) small enough that big boards like Pnet
// don't blow past the model's output limit and truncate the JSON mid-array
// ("Unterminated string in JSON"), which used to silently drop the whole page.

// Tolerant parse of the AI's job array. Strips markdown fences, isolates the
// first JSON array, and — if the response was cut off mid-way — salvages it by
// trimming back to the last complete object and closing the array. Returns an
// array on success, or null if nothing usable could be recovered.
function parseJobsLoose(raw) {
  if (!raw) return null;
  let s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const start = s.indexOf('[');
  if (start === -1) return null;
  s = s.slice(start);
  try { const a = JSON.parse(s); if (Array.isArray(a)) return a; } catch (_) {}
  const lastBrace = s.lastIndexOf('}');
  if (lastBrace !== -1) {
    try { const a = JSON.parse(s.slice(0, lastBrace + 1) + ']'); if (Array.isArray(a)) return a; } catch (_) {}
  }
  return null;
}

// Ask the AI which of the extracted job titles are a REASONABLE fit for this
// seeker's target roles — understanding related/synonymous titles instead of
// matching literal words. This is what makes the agent smart: a seeker who
// wants "data capture" also gets "Data Capturer", "Data Entry Clerk",
// "Capturing Clerk", etc., without anyone having to list every synonym — while
// clearly more senior / more technical / unrelated roles (Data Scientist,
// Data Engineer, Software Developer) are left out. Returns a prompt whose
// reply is a JSON array of the 1-based numbers that fit, e.g. [1,4,5].
function buildRelevancePrompt(titles, seeker) {
  const roles = (seeker.job_title_keywords || []).join(', ') || 'any';
  return `A job seeker is looking for roles like: ${roles}.
Their highest qualification is: ${seeker.highest_qualification || 'not stated'}.

Below is a numbered list of job titles found on a job board. Decide which titles are a REASONABLE match for what this seeker is looking for.
- INCLUDE closely related or synonymous roles. For example, if they want "data capture", then "Data Capturer", "Data Entry Clerk", "Capturing Clerk", "Admin Clerk (data entry)" all count.
- EXCLUDE roles that are clearly more senior, more technical, or in a different field. For example "Data Scientist", "Data Engineer", "Senior Data Analyst", "Software Developer" do NOT count for a data-capture seeker.
- When unsure about a borderline title that is the same kind of work, lean towards INCLUDING it — later checks will still read the full ad.

Reply with ONLY a JSON array of the matching numbers, e.g. [1,4,5]. If none match, reply exactly: []

TITLES:
${titles.map((t, i) => `${i + 1}. ${t}`).join('\n')}`;
}

// Resolve which extracted jobs are relevant for a seeker. Prefers AI judgement
// (semantic, synonym-aware). Falls back to the old literal word-overlap gate
// ONLY when the AI is unavailable or its reply can't be parsed, so matching
// never silently stops when the AI is down.
async function relevantJobIndexes(jobs, seeker, override) {
  const canAI = aiMatch.isEnabled() || override;
  if (canAI) {
    try {
      const raw = await aiMatch.completeWithAI(buildRelevancePrompt(jobs.map(j => j.title), seeker), override);
      const arr = parseJobsLoose(raw);
      if (Array.isArray(arr)) {
        const set = new Set(arr.map(n => Number(n) - 1).filter(n => Number.isInteger(n) && n >= 0 && n < jobs.length));
        return { set, usedAI: true };
      }
    } catch (_) { /* fall through to literal fallback */ }
  }
  // Fallback: literal all-words-of-a-target-role match (>= 0.3).
  const set = new Set();
  jobs.forEach((j, i) => { if (jobFit.scoreTitle(`${j.title}`, seeker.job_title_keywords) >= 0.3) set.add(i); });
  return { set, usedAI: false };
}

function buildExtractPrompt(links, pageUrl, agentPrompt) {
  const preamble = agentPrompt
    ? `${agentPrompt}\n\n`
    : '';
  return `${preamble}Below is a list of links found on a company/job-board page (${pageUrl}), as {"text","href","context"} pairs. "context" is nearby text taken from the posting's card. Identify which ones are actual job postings (ignore navigation, login, footer, social, pagination, and "about us"-type links).

For each real job posting, also identify the actual HIRING COMPANY / employer for THAT job when it appears in the text or context (for example "Imerys Refractory Minerals (Pty) Ltd"). This is the company the job is FOR — NOT the job board or recruitment site the link was found on (${pageUrl}), and NOT a generic label like "Apply now". If the posting only shows a recruitment agency acting for a client, use the name shown on the posting. If you cannot find a clear company name, use null — never guess, and never fall back to the job board's own name.

Reply with ONLY a JSON array, no other text, in this exact shape:
[{"title": "...", "url": "...", "location": "... or null", "company": "... or null"}]

If none of the links look like job postings, reply with exactly: []

LINKS:
${JSON.stringify(links)}`;
}

// Some job boards (e.g. Careers24, CareerJunction) don't print the hiring
// company on their LISTING cards, so best-effort listing extraction returns
// null for them. When that happens we open the posting's OWN detail page and
// read the employer from there, so the real company name shows for every board
// — never the board's own name. This is heavier (one extra page load + AI call
// per NEW posting), so it runs ONLY as a fallback (when the listing didn't give
// a company) and never throws: any failure just yields null.
function buildEmployerPrompt(text, url) {
  return `Below is the visible text of a single job posting's detail page (${url}). Identify the actual HIRING COMPANY / employer for this job — the company the job is FOR, NOT the job board or recruitment website, and NOT a generic label, button, menu item, or section heading. If the posting only names a recruitment agency acting for a client, use that agency name. If there is no clear company name anywhere, use null — never guess, and never fall back to the job board's own name.

Reply with ONLY a JSON object, no other text, in this exact shape:
{"company": "... or null"}

PAGE TEXT:
${String(text || '').slice(0, 4000)}`;
}

async function fetchEmployerFromDetail(browser, url) {
  let page = null;
  try {
    page = await browser.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
    const text = await page
      .evaluate(() => (document.body && (document.body.innerText || document.body.textContent) || '').replace(/\s+/g, ' ').trim())
      .catch(() => '');
    if (!text) return null;
    const raw = await aiMatch.completeWithAI(buildEmployerPrompt(text, url), null);
    if (!raw) return null;
    let obj = null;
    try { obj = JSON.parse(raw); }
    catch {
      const m = String(raw).match(/\{[\s\S]*\}/);
      if (m) { try { obj = JSON.parse(m[0]); } catch { /* ignore */ } }
    }
    const name = (obj && obj.company != null) ? String(obj.company).trim() : '';
    return name || null;
  } catch {
    return null;
  } finally {
    if (page) await page.close().catch(() => {});
  }
}

// A user can list several target roles (e.g. "Data Analyst, Data Processor,
// Data Capture"). Each keyword is an INDEPENDENT thing they'd take a job for,
// so a posting qualifies if it matches ANY one of them well — we return the
// best single-keyword match, not the fraction of all keywords. (The old
// hits/total formula punished having many roles: a job matching 1 of 5 scored
// 0.2 and got filtered out, so adding more roles found fewer jobs.)
function scoreMatch(text, keywords) {
  if (!keywords || keywords.length === 0) return 0;
  const haystack = text.toLowerCase();
  let best = 0;
  for (const kw of keywords) {
    const k = (kw || '').toLowerCase().trim();
    if (!k) continue;
    if (haystack.includes(k)) { best = 1; break; } // whole role phrase present — strongest possible match
    const words = k.split(/\s+/).filter(Boolean);
    if (!words.length) continue;
    const wordHits = words.filter(w => haystack.includes(w)).length;
    best = Math.max(best, wordHits / words.length); // partial: fraction of THIS role's words present
  }
  return best;
}

// Title used for the "this watched page could not be read" notice row. It has
// to live in job_matches because application_log.job_match_id is NOT NULL, but
// it is a notice, not a job — so label it unmistakably rather than leaving it
// looking like a real vacancy called "(watched page)" in the user's Matches.
const PAGE_NOTICE_TITLE = '⚠ Watched page could not be read (not a job)';

// Some watched pages — Pnet above all — sit behind Cloudflare and fail at the
// connection level on one run, then load perfectly on the next (2 Oct: failed
// 12:51, returned 4 postings at 14:04). Those are NOT broken-URL problems and
// must never be surfaced to the user, or every flaky run leaves permanent
// noise in their Matches. Only durable, actionable faults (dead domain, 404,
// bad certificate) are worth telling anyone about; transient ones stay in the
// Railway console where they belong.
function isTransientPageError(message) {
  const m = String(message || '');
  return /ERR_HTTP2_PROTOCOL_ERROR|ERR_CONNECTION_(RESET|CLOSED|REFUSED|ABORTED|TIMED_OUT)|ERR_NETWORK_CHANGED|ERR_SOCKET_NOT_CONNECTED|ERR_EMPTY_RESPONSE|ERR_TIMED_OUT|ERR_ADDRESS_UNREACHABLE|ERR_TOO_MANY_REDIRECTS|ERR_SSL_PROTOCOL_ERROR|Timeout .* exceeded|timed out|crashed|\b50[234]\b/i.test(m);
}

// When a previously-failing page starts working again, remove the old notice
// so a recovered source doesn't leave a phantom row sitting in Matches
// forever. Children in application_log go first (FK is NOT NULL).
async function clearStalePageReports(source) {
  const { data: stale } = await supabase
    .from('job_matches')
    .select('id')
    .eq('job_custom_source_id', source.id)
    .eq('job_url', source.career_page_url)
    .in('job_title', [PAGE_NOTICE_TITLE, '(watched page)']);
  const ids = (stale || []).map(r => r.id);
  if (!ids.length) return;
  await supabase.from('application_log').delete().in('job_match_id', ids);
  await supabase.from('job_matches').delete().in('id', ids);
  console.log(`[discoverWatched]  ✓ cleared ${ids.length} stale page-notice row(s) for "${source.company_name}" — page is readable again`);
}

// Have we already reported *something* against this exact URL for this
// seeker (a real job match, or an earlier "page unreachable" placeholder)?
// Used to make sure a broken/typo'd watched page gets reported once, not
// every single run.
async function alreadyKnown(seekerId, url) {
  const { data } = await supabase
    .from('job_matches')
    .select('id')
    .eq('job_seeker_id', seekerId)
    .eq('job_url', url)
    .maybeSingle();
  return !!data;
}

async function reportUnreachable(seeker, source, reason) {
  const placeholderUrl = source.career_page_url;
  if (await alreadyKnown(seeker.id, placeholderUrl)) return; // already reported once, don't pile up

  const { data: match, error: insErr } = await supabase.from('job_matches').insert({
    job_seeker_id: seeker.id,
    job_source_id: null,
    job_custom_source_id: source.id,
    job_title: PAGE_NOTICE_TITLE,
    company_name: source.company_name,
    job_url: placeholderUrl,
    status: 'needs_manual_action',
    is_custom_source: true
  }).select().single();
  if (insErr) { console.error('[discoverWatched]  ✖ could not record unreachable-page report:', insErr.message); return; }

  await supabase.from('application_log').insert({
    job_match_id: match.id,
    job_seeker_id: seeker.id,
    result: 'needs_manual_action',
    notes: `Could not reach ${source.company_name}'s watched page (${placeholderUrl}) — ${reason}. Check the URL is correct and the page is public.`
  });
  console.log(`[discoverWatched]  ⚠ reported "${source.company_name}" as unreachable`);
}

// Report a discovery problem for a source to every active seeker who still
// has it (i.e. hasn't opted out). This is what surfaces a broken/silent
// watched page in the admin's Application Report and the user's Applications
// tab — previously reportUnreachable existed but was never called, so every
// failure only ever hit the Railway console and nothing reached the DB.
async function reportProblemToSeekers(seekers, optedOut, source, reason) {
  for (const seeker of (seekers || [])) {
    if (optedOut.has(`${seeker.id}|${source.id}`)) continue;
    await reportUnreachable(seeker, source, reason);
  }
}

async function run() {
  console.log(`[discoverWatched] starting run at ${new Date().toISOString()}`);

  await aiMatch.loadSettings(supabase);

  if (!aiMatch.isAgentEnabled()) {
    console.log('[discoverWatched] Agent master switch is OFF (dispatch_settings.agent_enabled=false). Skipping this run.');
    return;
  }

  // 1. Fetch all active global watched company sources
  const { data: sources, error: sErr } = await supabase
    .from('job_custom_sources')
    .select('*')
    .eq('is_global', true)
    .eq('active', true);

  if (sErr) { console.error('[discoverWatched] failed to load global sources:', sErr.message); return; }
  if (!sources || sources.length === 0) {
    console.log('[discoverWatched] no active global watched company sources found.');
    return;
  }

  // 2. Fetch all active seekers
  const { data: seekers, error: kErr } = await supabase
    .from('job_seekers')
    .select('*')
    .eq('status', 'active');

  if (kErr) { console.error('[discoverWatched] failed to load seekers:', kErr.message); return; }
  if (!seekers || seekers.length === 0) {
    console.log('[discoverWatched] no active seekers found.');
    return;
  }

  // 2b. Per-seeker opt-outs. A user "removing" a watched page in the app does
  // NOT delete it (only an admin can do that) — it records an opt-out here, so
  // the source stops feeding THAT seeker while staying live for everyone else.
  const { data: optOuts, error: oErr } = await supabase
    .from('job_custom_source_optouts')
    .select('job_seeker_id, job_custom_source_id');

  if (oErr) console.warn('[discoverWatched] could not load opt-outs, continuing without them:', oErr.message);
  const optedOut = new Set((optOuts || []).map(o => `${o.job_seeker_id}|${o.job_custom_source_id}`));

  const browser = await chromium.launch({ headless: true });
  // Caches the real employer per posting URL for this run, so a detail-page
  // lookup happens at most once per URL even if several seekers match it.
  const employerCache = new Map();

  for (const source of sources) {
    console.log(`[discoverWatched] scanning global company: "${source.company_name}" (${source.career_page_url})`);

    // Scrape page ONCE per source
    let links = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 2 && links === null; attempt++) {
      const page = await browser.newPage();
      try {
        await page.goto(source.career_page_url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
        links = await page.$$eval('a[href]', els => els
          .map(e => {
            // Capture the text of the posting "card" around the link so the AI
            // can read the employer/company that usually sits next to the title
            // (the anchor text itself is almost always just the job title). We
            // walk up a few levels and cap the length so the AI payload stays
            // small. This is ADDITIVE context only — it does not change which
            // links are considered or how relevance is decided.
            let ctx = '';
            let node = e;
            for (let up = 0; up < 3 && node; up++) node = node.parentElement;
            if (node) ctx = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 300);
            return { text: (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' '), href: e.href, context: ctx };
          })
          .filter(l => l.text && l.text.length > 2 && l.text.length < 200)
        );
      } catch (err) {
        lastErr = err;
        const isCrash = /crashed/i.test(err.message || '');
        if (isCrash && attempt === 1) {
          console.warn(`[discoverWatched]  ⚠ browser tab crashed loading "${source.company_name}" — retrying once`);
        }
      } finally {
        await page.close().catch(() => {});
      }
    }
    
    if (links === null) {
      console.error(`[discoverWatched]  ✖ could not load page "${source.company_name}":`, lastErr?.message);
      // Transient connection-level failures are expected on anti-bot sites and
      // usually fix themselves on the next run, so they are logged only. A
      // durable fault (dead domain, 404, bad cert) still reaches the user,
      // because that one genuinely needs a human to fix the URL.
      if (isTransientPageError(lastErr?.message)) {
        console.warn(`[discoverWatched]  ↻ treating "${source.company_name}" as a temporary failure — not reporting to users; will retry next run`);
      } else {
        await reportProblemToSeekers(seekers, optedOut, source, `the page could not be loaded (${lastErr?.message || 'unknown error'}) — the site may be down, the URL may be wrong, or the domain may no longer exist`);
      }
      await supabase.from('job_custom_sources').update({ last_checked_at: new Date().toISOString() }).eq('id', source.id);
      continue;
    }

    if (!links.length) {
      console.log(`[discoverWatched]  page loaded but no readable links found on "${source.company_name}"`);
      await reportProblemToSeekers(seekers, optedOut, source, 'the page loaded but no readable links were found — it is likely a JavaScript-rendered board that needs a different scraping approach, or it is behind a login/anti-bot wall');
      await supabase.from('job_custom_sources').update({ last_checked_at: new Date().toISOString() }).eq('id', source.id);
      continue;
    }

    // Extract jobs with AI. Big boards can list hundreds of links, and asking
    // the model to return them all in one JSON array used to overflow its
    // output limit and truncate the response mid-array (Pnet's "Unterminated
    // string in JSON"). We now send the links in small chunks and merge the
    // results, so no single response has to be large enough to truncate.
    const linkSlice = links.slice(0, MAX_LINKS);
    const aiAvailable = aiMatch.isEnabled();
    let jobs = [];
    let sawAnyResponse = false;
    let anyChunkUnparseable = false;
    for (let i = 0; i < linkSlice.length; i += LINKS_PER_CHUNK) {
      const chunk = linkSlice.slice(i, i + LINKS_PER_CHUNK);
      const raw = await aiMatch.completeWithAI(buildExtractPrompt(chunk, source.career_page_url, aiMatch.agentPrompt()), null);
      if (raw === null || raw === '') continue; // AI disabled or empty for this chunk
      sawAnyResponse = true;
      const parsed = parseJobsLoose(raw);
      if (parsed === null) { anyChunkUnparseable = true; continue; }
      jobs = jobs.concat(parsed);
    }

    if (!sawAnyResponse) {
      console.log(`[discoverWatched]  ⚠ AI extraction returned nothing for "${source.company_name}"`);
      // Only surface this to seekers when the AI is actually configured — a
      // missing shared key is a global config problem, not a per-company one,
      // and shouldn't spam every company's report.
      if (aiAvailable) {
        await reportProblemToSeekers(seekers, optedOut, source, 'the job list on this page could not be read (the AI extraction service returned no response)');
      }
      await supabase.from('job_custom_sources').update({ last_checked_at: new Date().toISOString() }).eq('id', source.id);
      continue;
    }

    if (jobs.length === 0) {
      const reason = anyChunkUnparseable
        ? 'the job list on this page could not be read (the AI response was not valid JSON, even after recovery)'
        : 'no job postings could be identified on this page — it is likely a landing or search page rather than a direct job list, or the postings require login to view';
      console.log(`[discoverWatched]  ⚠ 0 postings from "${source.company_name}" — ${reason}`);
      await reportProblemToSeekers(seekers, optedOut, source, reason);
      await supabase.from('job_custom_sources').update({ last_checked_at: new Date().toISOString() }).eq('id', source.id);
      continue;
    }

    console.log(`[discoverWatched]  ${jobs.length} posting(s) extracted from "${source.company_name}"`);

    // The page is demonstrably readable, so drop any older "could not be read"
    // notice left behind by a previous failed run.
    await clearStalePageReports(source);

    // 3. Loop through all seekers and match jobs
    for (const seeker of seekers) {
      if (seeker.api_provider === 'none') continue;
      if (optedOut.has(`${seeker.id}|${source.id}`)) continue; // user removed it from their own account
      const override = aiMatch.resolveSeekerOverride(seeker);
      if (!aiMatch.isEnabled() && !override) continue;

      // Check block list
      const blocked = (seeker.blocked_companies || []).map(c => String(c || '').trim().toLowerCase());
      if (blocked.includes(String(source.company_name).trim().toLowerCase())) {
        continue;
      }

      // Smart relevance: the AI decides which extracted titles actually fit
      // this seeker's target roles, understanding related/synonymous titles
      // rather than requiring the seeker's literal words to appear in the
      // title. (Replaces the old `scoreTitle < 0.3` gate, which dropped
      // "Data Capturer" for a "data capture" seeker because the words didn't
      // line up — starving the pipeline even though the right jobs were there.)
      const { set: relevantIdx, usedAI } = await relevantJobIndexes(jobs, seeker, override);
      if (relevantIdx.size === 0) continue;

      for (let ji = 0; ji < jobs.length; ji++) {
        if (!relevantIdx.has(ji)) continue;
        const job = jobs[ji];
        if (!job.title || !job.url) continue;

        let absoluteUrl;
        try { absoluteUrl = new URL(job.url, source.career_page_url).href; }
        catch { continue; }

        // Seniority guard still applies as a BACKSTOP: a role above the
        // seeker's level is still saved (so it shows in Matches) but as
        // 'skipped' with a reason, so the agent won't auto-apply unless the
        // user presses Apply. This runs whether the match came from the AI or
        // the literal fallback, so the agent can never drift up into
        // engineer / scientist / manager roles for a sub-degree seeker.
        const skipWhy = jobFit.titleSkipReason(job.title, seeker);

        if (await alreadyKnown(seeker.id, absoluteUrl)) continue;

        // match_score: use the literal word-overlap score when it's positive;
        // otherwise this was an AI-judged related match, so record a sensible
        // baseline (75) instead of 0 so it ranks reasonably in Matches.
        const relevance = jobFit.scoreTitle(`${job.title}`, seeker.job_title_keywords);
        const score = relevance > 0 ? Math.round(relevance * 100) : (usedAI ? 75 : 0);

        // Resolve the REAL hiring company. Prefer what the listing gave us; when
        // the board hides it there (Careers24, CareerJunction, …), fall back to
        // reading the posting's own detail page. Cached per URL for this run so
        // we open each detail page at most once.
        let employer = (job.company && String(job.company).trim()) ? String(job.company).trim() : null;
        if (!employer) {
          if (employerCache.has(absoluteUrl)) {
            employer = employerCache.get(absoluteUrl);
          } else {
            employer = await fetchEmployerFromDetail(browser, absoluteUrl);
            employerCache.set(absoluteUrl, employer);
          }
        }

        const { error: insErr } = await supabase.from('job_matches').insert({
          job_seeker_id: seeker.id,
          job_source_id: null,
          job_custom_source_id: source.id,
          job_title: job.title,
          company_name: source.company_name,
          // The real hiring company for this posting (kept separate from
          // company_name so block-lists/routing on the source still work).
          // Taken from the listing when present, otherwise from the posting's
          // detail page. Null only when neither shows a company.
          employer_name: employer,
          job_url: absoluteUrl,
          location: job.location || null,
          match_score: score, // stored as integer 0..100 like every other source
          status: skipWhy ? 'skipped' : 'pending',
          skip_reason: skipWhy ? jobFit.skipMessage(skipWhy) : null,
          is_custom_source: true
        });

        if (insErr) console.error(`[discoverWatched]  ✖ insert failed for ${seeker.full_name}:`, insErr.message);
        else console.log(`[discoverWatched]  ✔ new match: "${job.title}" @ ${source.company_name} for ${seeker.full_name}`);
      }
    }

    // Update last_checked_at for the source
    await supabase.from('job_custom_sources').update({ last_checked_at: new Date().toISOString() }).eq('id', source.id);
  }

  await browser.close();
  console.log('[discoverWatched] run complete');
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
