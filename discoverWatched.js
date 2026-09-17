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

const MAX_LINKS = 400; // keep the AI prompt a reasonable size/cost

function buildExtractPrompt(links, pageUrl, agentPrompt) {
  const preamble = agentPrompt
    ? `${agentPrompt}\n\n`
    : '';
  return `${preamble}Below is a list of links found on a company/job-board page (${pageUrl}), as {"text","href"} pairs. Identify which ones are actual job postings (ignore navigation, login, footer, social, pagination, and "about us"-type links).

Reply with ONLY a JSON array, no other text, in this exact shape:
[{"title": "...", "url": "...", "location": "... or null"}]

If none of the links look like job postings, reply with exactly: []

LINKS:
${JSON.stringify(links)}`;
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
    job_title: '(watched page)',
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

async function run() {
  console.log(`[discoverWatched] starting run at ${new Date().toISOString()}`);

  await aiMatch.loadSettings(supabase);

  if (!aiMatch.isAgentEnabled()) {
    console.log('[discoverWatched] Agent master switch is OFF (dispatch_settings.agent_enabled=false). Skipping this run.');
    return;
  }

  const { data: watched, error: wErr } = await supabase
    .from('job_custom_sources')
    .select('*, job_seekers(*)');

  if (wErr) { console.error('[discoverWatched] failed to load job_custom_sources:', wErr.message); return; }
  if (!watched || watched.length === 0) {
    console.log('[discoverWatched] no watched pages added by any user yet.');
    return;
  }

  const browser = await chromium.launch({ headless: true });

  for (const source of watched) {
    const seeker = source.job_seekers;
    if (!seeker || seeker.status !== 'active') continue;

    // AI is required to interpret an arbitrary page — use the seeker's own
    // key if they've set one, otherwise the shared key. Only skip THIS
    // seeker (not the whole run) when neither is available.
    // A seeker set to 'none' has deliberately opted out of AI entirely —
    // that must never silently fall back to the shared company key.
    if (seeker.api_provider === 'none') {
      console.log(`[discoverWatched]  ⚠ skipping "${source.company_name}" for ${seeker.full_name} — AI access is turned off for this seeker`);
      continue;
    }
    const override = aiMatch.resolveSeekerOverride(seeker);
    if (!aiMatch.isEnabled() && !override) {
      console.log(`[discoverWatched]  ⚠ skipping "${source.company_name}" for ${seeker.full_name} — no AI key available (no shared key set, and this seeker has no personal key)`);
      continue;
    }

    console.log(`[discoverWatched] checking "${source.company_name}" (${source.career_page_url}) for ${seeker.full_name}${override ? ' (using their own API key)' : ''}`);

    // A crashed renderer ("Target crashed" / "Page crashed") is a transient
    // resource hiccup in this container, not a real problem with the page
    // itself — retry once on a brand-new page before reporting the watched
    // page as unreachable (see apply.js for the same pattern and rationale).
    let links = null;
    let lastErr = null;
    for (let attempt = 1; attempt <= 2 && links === null; attempt++) {
      const page = await browser.newPage();
      try {
        await page.goto(source.career_page_url, { waitUntil: 'domcontentloaded', timeout: 25000 });
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}); // best effort — some pages never go fully idle
        links = await page.$$eval('a[href]', els => els
          .map(e => ({ text: (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' '), href: e.href }))
          .filter(l => l.text && l.text.length > 2 && l.text.length < 200)
        );
      } catch (err) {
        lastErr = err;
        const isCrash = /crashed/i.test(err.message || '');
        if (isCrash && attempt === 1) {
          console.warn(`[discoverWatched]  ⚠ browser tab crashed loading "${source.company_name}" — retrying once with a fresh page`);
        }
      } finally {
        await page.close().catch(() => {}); // a crashed target can make close() itself throw
      }
    }
    if (links === null) {
      const err = lastErr;
      const isNetworkIssue = /net::|ERR_|timeout|ENOTFOUND|EAI_AGAIN/i.test(err.message || '');
      const reason = isNetworkIssue
        ? 'the address could not be reached (broken link, typo, or the site is down)'
        : `an unexpected error occurred (${err.message})`;
      console.error(`[discoverWatched]  ✖ could not load page:`, err.message);
      await reportUnreachable(seeker, source, reason);
      continue;
    }

    if (!links.length) {
      console.log(`[discoverWatched]  page loaded but no readable links found on "${source.company_name}"`);
      continue;
    }

    const raw = await aiMatch.completeWithAI(buildExtractPrompt(links.slice(0, MAX_LINKS), source.career_page_url, aiMatch.agentPrompt()), override);
    if (!raw) {
      console.log(`[discoverWatched]  ⚠ AI extraction failed or returned nothing for "${source.company_name}"`);
      continue;
    }

    let jobs;
    try {
      const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      jobs = JSON.parse(cleaned);
      if (!Array.isArray(jobs)) throw new Error('AI did not return a JSON array');
    } catch (err) {
      console.error(`[discoverWatched]  ✖ could not parse AI extraction result:`, err.message);
      continue;
    }

    console.log(`[discoverWatched]  ${jobs.length} posting(s) extracted from "${source.company_name}"`);

    for (const job of jobs) {
      if (!job.title || !job.url) continue;

      let absoluteUrl;
      try { absoluteUrl = new URL(job.url, source.career_page_url).href; }
      catch { continue; } // malformed URL from the AI — skip rather than insert garbage

      const relevance = scoreMatch(`${job.title}`, seeker.job_title_keywords);
      if (relevance < 0.3) continue; // lighter threshold than structured sources, since these are user-requested watches

      if (await alreadyKnown(seeker.id, absoluteUrl)) continue; // already discovered (and possibly already applied/reported) — never re-process the same posting

      const { error: insErr } = await supabase.from('job_matches').insert({
        job_seeker_id: seeker.id,
        job_source_id: null, // not tied to the shared job_sources catalog — user-added
        job_title: job.title,
        company_name: source.company_name,
        job_url: absoluteUrl,
        location: job.location || null,
        match_score: Number(relevance.toFixed(2)),
        status: 'pending',
        is_custom_source: true
      });

      if (insErr) console.error('[discoverWatched]  ✖ insert failed:', insErr.message);
      else console.log(`[discoverWatched]  ✔ new watched match: "${job.title}" @ ${source.company_name} for ${seeker.full_name}`);
    }
  }

  await browser.close();
  console.log('[discoverWatched] run complete');
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
