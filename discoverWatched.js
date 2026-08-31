require('dotenv').config();
const supabase = require('./supabaseClient');
const aiMatch = require('./aiMatch');

// Handles job_custom_sources — company career pages a user has added
// themselves ("Watched pages" in the app). This previously had NO backend
// implementation at all: users could add a page, and it would just sit in
// the database untouched. This module is what actually makes it work.
//
// Unlike job_sources (Greenhouse/Lever/etc., which publish a structured
// JSON feed), a custom career page is arbitrary HTML with no fixed
// structure — there's no reliable rule-based way to parse "what's a job
// listing" here, so this is the one place in the system where AI does the
// actual discovery, not just the scoring. It uses the same shared
// DigitalHouse key as everything else.
//
// Matches found this way are always is_custom_source: true — apply.js
// already deliberately excludes these from auto-apply (arbitrary company
// pages have no consistent form to safely automate), so this is
// discovery-only by design, same as before.

const MAX_HTML_CHARS = 12000; // keep the AI prompt a reasonable size/cost

function stripHtmlNoise(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .slice(0, MAX_HTML_CHARS);
}

function scoreMatch(text, keywords) {
  if (!keywords || keywords.length === 0) return 0;
  const haystack = text.toLowerCase();
  const hits = keywords.filter(k => haystack.includes(k.toLowerCase())).length;
  return hits / keywords.length;
}

const EXTRACT_PROMPT = (pageHtml, pageUrl) => `Below is raw HTML from a company's careers page (${pageUrl}). Extract every distinct job posting visible on this page.

Reply with ONLY a JSON array, no other text, in this exact shape:
[{"title": "...", "url": "...", "location": "... or null", "description": "short 1-2 sentence summary or null"}]

If a job's URL is relative (e.g. "/jobs/123"), resolve it into a full absolute URL using ${pageUrl} as the base. If you find no job postings at all, reply with exactly: []

HTML:
${pageHtml}`;

async function run() {
  console.log(`[discoverWatched] starting run at ${new Date().toISOString()}`);

  await aiMatch.loadSettings(supabase);
  if (!aiMatch.isEnabled()) {
    console.log('[discoverWatched] no shared AI key set in Dispatch Admin > AI settings — this feature requires AI to interpret arbitrary pages, skipping run entirely.');
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

  for (const source of watched) {
    const seeker = source.job_seekers;
    if (!seeker || seeker.status !== 'active') continue;

    console.log(`[discoverWatched] checking "${source.company_name}" (${source.career_page_url}) for ${seeker.full_name}`);

    let html;
    try {
      const res = await fetch(source.career_page_url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      html = await res.text();
    } catch (err) {
      console.error(`[discoverWatched]  ✖ could not fetch page:`, err.message);
      continue;
    }

    const cleanedHtml = stripHtmlNoise(html);
    const raw = await aiMatch.completeWithAI(EXTRACT_PROMPT(cleanedHtml, source.career_page_url));
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

      const keywordText = `${job.title} ${job.description || ''}`;
      const relevance = scoreMatch(keywordText, seeker.job_title_keywords);
      if (relevance < 0.3) continue; // lighter threshold than structured sources, since these are user-requested watches

      const { data: existing } = await supabase
        .from('job_matches')
        .select('id')
        .eq('job_seeker_id', seeker.id)
        .eq('job_url', absoluteUrl)
        .maybeSingle();
      if (existing) continue;

      const { error: insErr } = await supabase.from('job_matches').insert({
        job_seeker_id: seeker.id,
        job_source_id: null, // not tied to the shared job_sources catalog — user-added
        job_title: job.title,
        company_name: source.company_name,
        job_url: absoluteUrl,
        location: job.location || null,
        match_score: Number(relevance.toFixed(2)),
        match_reason: job.description || null,
        status: 'pending',
        is_custom_source: true
      });

      if (insErr) console.error('[discoverWatched]  ✖ insert failed:', insErr.message);
      else console.log(`[discoverWatched]  ✔ new watched match: "${job.title}" @ ${source.company_name} for ${seeker.full_name}`);
    }
  }

  console.log('[discoverWatched] run complete');
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
