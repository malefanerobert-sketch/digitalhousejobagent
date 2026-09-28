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
    job_custom_source_id: source.id,
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
          .map(e => ({ text: (e.innerText || e.textContent || '').trim().replace(/\s+/g, ' '), href: e.href }))
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
      await reportProblemToSeekers(seekers, optedOut, source, `the page could not be loaded (${lastErr?.message || 'unknown error'}) — the site may be down, the URL may be wrong, or the domain may no longer exist`);
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

      for (const job of jobs) {
        if (!job.title || !job.url) continue;

        let absoluteUrl;
        try { absoluteUrl = new URL(job.url, source.career_page_url).href; }
        catch { continue; }

        const relevance = scoreMatch(`${job.title}`, seeker.job_title_keywords);
        if (relevance < 0.3) continue;

        if (await alreadyKnown(seeker.id, absoluteUrl)) continue;

        const { error: insErr } = await supabase.from('job_matches').insert({
          job_seeker_id: seeker.id,
          job_source_id: null,
          job_custom_source_id: source.id,
          job_title: job.title,
          company_name: source.company_name,
          job_url: absoluteUrl,
          location: job.location || null,
          match_score: Number(relevance.toFixed(2)),
          status: 'pending',
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
