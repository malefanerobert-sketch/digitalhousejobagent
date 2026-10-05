#!/usr/bin/env node
/**
 * discoverAuto.js - Autonomous Job Discovery Worker
 * Queries ALL enabled job sources for each user
 * Time window configurable by admin via dispatch_settings
 * Scores matches with Claude API, saves to job_matches
 *
 * Runs as part of the shared worker process (index.js schedules it on
 * DISCOVER_CRON, alongside discoverWatched on WATCH_CRON and apply on
 * APPLY_CRON) — so nothing in here may call process.exit(), since that
 * would kill the whole worker and its other cron jobs with it. Every
 * early-return uses `return` instead. `node discoverAuto.js` directly
 * still works standalone for manual testing (see bottom of file).
 */

const Anthropic = require('@anthropic-ai/sdk');
const sb = require('./supabaseClient');
const jobFit = require('./jobFit');

// Adzuna's app_id is a public identifier (not a secret); default to the one
// registered for this project so Railway only has to hold the secret app_key.
// Override with ADZUNA_APP_ID if you register a different Adzuna app later.
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID || '118cbf9d';
const ADZUNA_API_KEY = process.env.ADZUNA_API_KEY || '';

// The shared Agent key can be either an Anthropic or an OpenAI key — which
// provider it belongs to is decided by dispatch_settings.ai_provider (set
// in the admin panel). callScoringAI() below picks the right API for
// whichever provider is actually configured, instead of assuming Anthropic.
const DEFAULT_MODEL_BY_PROVIDER = { anthropic: 'claude-sonnet-4-5-20250929', openai: 'gpt-4o-mini', google: 'gemini-3.8-flash' };

// Config
const SA_TIMEZONE = 'Africa/Johannesburg';
const BATCH_SIZE = 5; // Jobs per batch for Claude scoring
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';

let adminSettings = null; // Will be loaded from DB

/**
 * Load admin settings (time window, timezone, etc).
 * Returns true if the run should proceed, false if the master switch is off.
 */
async function loadAdminSettings() {
  const { data, error } = await sb
    .from('dispatch_settings')
    .select('agent_enabled, agent_run_start_hour, agent_run_end_hour, agent_timezone, ai_provider, ai_api_key, ai_model')
    .eq('id', true)
    .single();

  if (error || !data) {
    console.warn('⚠ Could not load admin settings, using defaults (8am-4pm SA)');
    adminSettings = {
      enabled: true,
      start_hour: 8,
      end_hour: 16,
      timezone: SA_TIMEZONE,
      ai_provider: 'anthropic',
      ai_api_key: process.env.CLAUDE_API_KEY || null,
      ai_model: DEFAULT_CLAUDE_MODEL
    };
  } else {
    adminSettings = {
      enabled: data.agent_enabled !== false,
      start_hour: data.agent_run_start_hour ?? 8,
      end_hour: data.agent_run_end_hour ?? 16,
      timezone: data.agent_timezone || SA_TIMEZONE,
      ai_provider: data.ai_provider || 'anthropic',
      ai_api_key: process.env.CLAUDE_API_KEY || data.ai_api_key || null,
      // The admin app has no model field, so data.ai_model is normally empty.
      // Default to the right model for whichever provider is configured — never
      // force Claude onto a Google/OpenAI key (that mismatch caused the 404s).
      ai_model: data.ai_model || DEFAULT_MODEL_BY_PROVIDER[data.ai_provider || 'anthropic'] || DEFAULT_CLAUDE_MODEL
    };
    console.log(`⏰ Admin time window: ${adminSettings.start_hour}:00 - ${adminSettings.end_hour}:00 ${adminSettings.timezone}`);
    console.log(`🎛  Agent master switch: ${adminSettings.enabled ? 'ON' : 'OFF'}`);
    console.log(`Agent AI model: ${adminSettings.ai_model} (key ${adminSettings.ai_api_key ? 'present' : 'MISSING'})`);
  }

  // Master switch check
  if (!adminSettings.enabled && process.env.SKIP_ENABLED_CHECK !== 'true') {
    console.log('🛑 [discoverAuto] Agent master switch is OFF (dispatch_settings.agent_enabled=false). Skipping this run.');
    return false;
  }

  if (!adminSettings.ai_api_key) {
    console.warn('⚠ No Agent API key available — AI scoring is unavailable; deterministic title scoring will be used');
  }

  return true;
}

/**
 * Check if current time is within the admin-configured time window.
 *
 * Supports three shapes, all encoded on the same two integer hours the admin
 * panel writes to dispatch_settings:
 *
 *   1. Daytime window: start < end. Open when hour ∈ [start, end).
 *      Example: 8 → 16 covers 08:00–15:59.
 *   2. Overnight window: start > end. Wraps midnight, open when
 *      hour ≥ start OR hour < end. Example: 22 → 6 covers 22:00–05:59.
 *   3. Always on (24/7): start === end. Any hour is inside the window.
 *
 * Historically only case #1 was supported and start ≥ end silently made the
 * agent never fire (the admin panel used to reject those saves outright).
 * The new panel offers an "Always on" toggle and lets end wrap past midnight,
 * so this function must recognise both cases or those saves would be dead on
 * arrival.
 */
function isWithinTimeWindow() {
  // Allow skipping time window check for testing via SKIP_TIME_CHECK env var
  if (process.env.SKIP_TIME_CHECK === 'true') {
    console.log('⏭️  Time window check skipped (SKIP_TIME_CHECK=true)');
    return true;
  }

  if (!adminSettings) {
    console.warn('⚠ Admin settings not loaded, allowing execution');
    return true;
  }

  const { start_hour: start, end_hour: end } = adminSettings;

  // 24/7 sentinel: start === end means "no time restriction". This is what
  // the admin panel writes when the operator toggles "Always on".
  if (start === end) return true;

  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: adminSettings.timezone,
    hour: '2-digit',
    hour12: false
  });
  const [hourStr] = formatter.format(now).split(':');
  const hour = parseInt(hourStr);

  // Overnight window (e.g. 22 → 6): open when we're past `start` today OR
  // before `end` tomorrow. A plain `hour >= start && hour < end` would be
  // false for every hour in this case, which is exactly the bug the old code
  // shipped for anyone who managed to save such a window.
  if (start > end) return hour >= start || hour < end;

  return hour >= start && hour < end;
}

/**
 * Generic job fetcher - handles all source types
 */
async function fetchJobsFromSource(source, query = 'software') {
  console.log(`  🔍 Fetching from ${source.name}...`);

  try {
    switch (source.source_type) {
      case 'adzuna':
        return await fetchAdzunaJobs(source, query);
      case 'remoteok':
        return await fetchRemoteOKJobs(source, query);
      case 'jobmail':
        return await fetchJobmailJobs(source, query);
      case 'jnet':
        return await fetchJnetJobs(source, query);
      case 'careerjunction':
        return await fetchCareerJunctionJobs(source, query);
      default:
        console.warn(`⚠ Unknown source type: ${source.source_type}`);
        return [];
    }
  } catch (err) {
    console.error(`❌ ${source.name} fetch failed:`, err.message);
    return [];
  }
}

/**
 * Fetch jobs from Adzuna API
 */
async function fetchAdzunaJobs(source, query = 'software') {
  const appId = ADZUNA_APP_ID;
  const appKey = ADZUNA_API_KEY;
  if (!appKey) {
    console.warn('    ⚠ Adzuna skipped: ADZUNA_API_KEY env var required (app_id defaults to project value)');
    return [];
  }

  try {
    const url = new URL('https://api.adzuna.com/v1/api/jobs/za/search/1');
    url.searchParams.append('app_id', appId);
    url.searchParams.append('app_key', appKey);
    url.searchParams.append('results_per_page', '50');
    url.searchParams.append('what', query);
    url.searchParams.append('sort_by', 'date');

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Adzuna HTTP ${res.status}`);

    const data = await res.json();
    console.log(`    ✓ Adzuna: ${data.results?.length || 0} jobs`);

    return (data.results || []).map(job => ({
      source: 'adzuna',
      job_id: `adzuna_${job.id}`,
      title: job.title,
      company: job.company?.display_name || 'N/A',
      location: job.location?.display_name || 'ZA',
      description: job.description || '',
      // DEDUP FIX: job.redirect_url carries Adzuna's rotating `se=` session
      // token plus utm params that change on every crawl, so the same ad got
      // a different job_url each run and slipped past the
      // (job_seeker_id, job_url) unique constraint — re-inserting the same
      // posting over and over (one real ad showed up 12 times). job.id is
      // Adzuna's stable ad identifier, so build a canonical, param-free URL
      // from it. This dedups correctly AND still opens the real listing.
      url: `https://www.adzuna.co.za/details/${job.id}`,
      posted_at: new Date(job.created).toISOString(),
      salary_min: job.salary_min,
      salary_max: job.salary_max,
      remote: job.description?.toLowerCase().includes('remote') || false
    }));
  } catch (err) {
    console.error('❌ Adzuna fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch jobs from RemoteOK
 *
 * STRICTLY South Africa only. We keep a posting only if its location or
 * description explicitly names South Africa / ZA / a South-African city, or
 * if it lists ZA among its allowed regions. Worldwide / anywhere / Remote-only
 * postings are dropped — even though the seeker could theoretically apply,
 * the requirement is SA-only.
 */
async function fetchRemoteOKJobs(source, query = 'software') {
  try {
    const res = await fetch('https://remoteok.com/api', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobDiscoveryBot/1.0)' }
    });
    if (!res.ok) throw new Error(`RemoteOK HTTP ${res.status}`);

    const raw = await res.json();
    const jobs = (raw || []).filter(j => j && j.id); // drops the legal-notice header

    // Explicit SA signals: country name, 'ZA' as a whole word, or major SA cities.
    const SA_REGEX = /(south africa|\bza\b|johannesburg|cape town|durban|pretoria|gauteng|western cape|eastern cape|bloemfontein|port elizabeth|stellenbosch|sandton|midrand|centurion|kwazulu[- ]?natal|mpumalanga|limpopo)/i;

    const q = (query || '').toLowerCase();
    const queryTerms = q.split(/\s+/).filter(Boolean);

    const filtered = jobs.filter(j => {
      const blob = `${j.location || ''} ${j.position || ''} ${j.description || ''} ${(j.tags || []).join(' ')} ${(j.region || []).join?.(' ') || j.region || ''}`;
      if (!SA_REGEX.test(blob)) return false; // strict SA gate
      if (!queryTerms.length) return true;
      const lower = blob.toLowerCase();
      return queryTerms.some(t => lower.includes(t));
    }).slice(0, 50);

    console.log(`    ✓ RemoteOK: ${filtered.length} SA jobs (of ${jobs.length} total)`);

    return filtered.map(job => ({
      source: 'remoteok',
      job_id: `remoteok_${job.id}`,
      title: job.position || 'Untitled',
      company: job.company || 'N/A',
      location: job.location || 'South Africa',
      description: (job.description || '').replace(/<[^>]+>/g, ' ').substring(0, 500),
      url: job.url || `https://remoteok.com/remote-jobs/${job.id}`,
      posted_at: job.epoch ? new Date(job.epoch * 1000).toISOString() : new Date().toISOString(),
      salary_min: job.salary_min || null,
      salary_max: job.salary_max || null,
      remote: true
    }));
  } catch (err) {
    console.error('❌ RemoteOK fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch jobs from Jobmail (HTML scraping — no public JSON API exists)
 * Search page: https://www.jobmail.co.za/jobs/search?q=<keywords>
 * Each result card is a <div class="job-info"> block with an anchor
 * id="jobDetailUrl-<id>" whose href is the job path and inner <h3> is the title.
 */
async function fetchJobmailJobs(source, query = 'software') {
  try {
    const url = new URL('https://www.jobmail.co.za/jobs/search');
    url.searchParams.append('q', query);

    const res = await fetch(url.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; JobDiscoveryBot/1.0)',
        'Accept': 'text/html'
      }
    });
    if (!res.ok) throw new Error(`Jobmail HTTP ${res.status}`);

    const html = await res.text();

    // Extract each job block: anchor with id="jobDetailUrl-<id>" href="/jobs/..."
    // The <h3> title lives inside the same anchor, and the location follows in
    // a nearby "job-location" span.
    const jobs = [];
    const anchorRe = /<a[^>]*class="tablinks"[^>]*id="jobDetailUrl-(\d+)"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
    let m;
    while ((m = anchorRe.exec(html)) !== null && jobs.length < 50) {
      const [, id, href, inner] = m;
      const titleMatch = inner.match(/<h3[^>]*>([^<]+)<\/h3>/);
      if (!titleMatch) continue;
      const title = titleMatch[1].replace(/&amp;/g, '&').trim();
      // Location is the third path segment of the href: /jobs/<cat>/<sub>/<location>/<slug-id>
      const pathParts = href.split('/').filter(Boolean);
      const locSlug = pathParts.length >= 4 ? pathParts[3] : 'south-africa';
      const location = locSlug.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()) + ', ZA';
      jobs.push({
        source: 'jobmail',
        job_id: `jobmail_${id}`,
        title,
        company: 'Via Jobmail',
        location,
        description: title, // description not in the search listing; Claude scores on title
        url: `https://www.jobmail.co.za${href}`,
        posted_at: new Date().toISOString(),
        salary_min: null,
        salary_max: null,
        remote: /remote/i.test(title)
      });
    }

    console.log(`    ✓ Jobmail: ${jobs.length} jobs (scraped)`);
    return jobs;
  } catch (err) {
    console.error('❌ Jobmail fetch failed:', err.message);
    return [];
  }
}

/**
 * Fetch jobs from Jnet (jobnet.co.za)
 *
 * Investigated 2026-09-14: jobnet.co.za is a thin landing page that embeds a
 * Careerjet search widget. It has no listings of its own and no scrapeable
 * search endpoint. Careerjet itself is behind Cloudflare Turnstile and its
 * public API now requires an authenticated legacy account.
 *
 * Returning [] honestly rather than pretending to hit a nonexistent API.
 * Admin can disable this source or an operator can plug in a Careerjet
 * partner key here later.
 */
async function fetchJnetJobs(source, query = 'software') {
  console.log(`    ⚠ Jnet: no server-side scrape available (site is a Careerjet iframe); skipping`);
  return [];
}

/**
 * Fetch jobs from CareerJunction
 *
 * Investigated 2026-09-14: careerjunction.co.za is behind Cloudflare bot
 * protection (returns HTTP/2 stream errors or verification pages to plain
 * fetch), and it does not expose a public JSON API. Real integration would
 * need either a partner feed / their internal API with credentials, or a
 * headless browser.
 *
 * Returning [] honestly rather than pretending to hit a nonexistent API.
 */
async function fetchCareerJunctionJobs(source, query = 'software') {
  console.log(`    ⚠ CareerJunction: blocked by bot protection, no public API; skipping`);
  return [];
}

/**
 * Calls whichever AI provider is actually configured (shared dispatch_settings
 * key, or a per-seeker override) and returns the raw text response. Mirrors
 * aiMatch.js's scoreWithAnthropic/scoreWithOpenAI split — this file used to
 * always build an Anthropic client from the shared key regardless of what
 * dispatch_settings.ai_provider actually said, so an admin who picked
 * "OpenAI (GPT)" in the admin panel for the shared key silently got every
 * autonomous-search job scored 0 (the Anthropic SDK rejects an OpenAI-shaped
 * key) instead of a real error — this fixes that by picking the API to call
 * based on the resolved provider, same as every other AI call in this app.
 */
async function callScoringAI(prompt, override) {
  const provider = override?.provider || adminSettings?.ai_provider;
  const apiKey = override?.apiKey || adminSettings?.ai_api_key;
  if (!provider || provider === 'none' || !apiKey) return null;
  // Only reuse the admin-configured model when the request is actually using
  // the admin's provider. A seeker's own key (e.g. Google) must never inherit
  // the admin's Claude model name — that mismatch is what caused Google to 404
  // on every scoring batch and silently fall back to title-only scoring.
  const adminModelFitsProvider =
    adminSettings?.ai_model && adminSettings?.ai_provider === provider;
  const model =
    override?.model ||
    (adminModelFitsProvider ? adminSettings.ai_model : null) ||
    DEFAULT_MODEL_BY_PROVIDER[provider];

  if (provider === 'anthropic') {
    const client = new Anthropic({ apiKey });
    const response = await client.messages.create({
      model,
      max_tokens: 200,
      messages: [{ role: 'user', content: prompt }]
    });
    return response.content?.[0]?.text || '';
  } else if (provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: 200, messages: [{ role: 'user', content: prompt }] })
    });
    if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
    const data = await res.json();
    return data.choices?.[0]?.message?.content || '';
  } else if (provider === 'google') {
    // Mirror of aiMatch.js callGemini: thinkingBudget=0 so Gemini 2.5+
    // (incl. 3.8-flash) stops burning the output-token budget on hidden
    // thoughts and actually returns the JSON reply this scorer parses.
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 200, thinkingConfig: { thinkingBudget: 0 } }
        })
      }
    );
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      throw new Error(`Google API error: ${res.status}${detail ? ' — ' + detail.slice(0, 200) : ''}`);
    }
    const data = await res.json();
    return (data.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('') || '';
  }
  return null; // unknown provider — treated the same as "not configured"
}

// Source labels that are NOT a real employer (Jobmail's scrape can't read the
// hiring company off the search listing, so it stores "Via Jobmail"). These
// must never be shown as the company name, so we treat them as "no company".
// Reject only the board's own name, bare field labels, and site-navigation text
// — NOT values the board genuinely lists as the employer (e.g. "Pvt", used by
// advertisers who stay private), which are shown as-is.
const PLACEHOLDER_COMPANY_RE = /^(via\s+.+|job\s?mail|jobmail|n\/?a|unknown|not\s+specified|not\s+stated|company|recruiter|employer|sign\s?up|log\s?in|login|register(?:ation)?|apply(?:\s?now)?|view|menu|search|home)\.?$/i;
function isPlaceholderCompany(n) {
  const s = String(n || '').trim();
  return !s || PLACEHOLDER_COMPANY_RE.test(s);
}
function decodeEntities(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&#x26;/gi, '&').replace(/&#38;/g, '&')
    .replace(/&#x2013;/gi, '–').replace(/&#8211;/g, '–').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
}
// Most SA job boards embed a schema.org JobPosting whose hiringOrganization is
// the real employer — the most reliable, zero-cost source. Parse it first.
function employerFromJsonLd(html) {
  const blocks = [...String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let d; try { d = JSON.parse(b[1].trim()); } catch { continue; }
    const arr = Array.isArray(d) ? d : [d];
    for (const x of arr) {
      const items = (x && x['@graph']) ? x['@graph'] : [x];
      for (const it of items) {
        if (it && it.hiringOrganization) {
          const h = it.hiringOrganization;
          const n = typeof h === 'string' ? h : (h && h.name);
          if (n) return decodeEntities(n);
        }
      }
    }
  }
  return null;
}

// Clean a raw posting into a focused, job-relevant description for the in-app
// viewer. Strips navigation, cookie notices, "opens in a new tab" boilerplate,
// and bounce-page copy. Returns null when the page has no real job content.
function buildDescriptionCleanupPrompt(raw) {
  return `Below is text scraped from a single job posting. Rewrite ONLY the job-relevant content as clean plain text that a candidate would want to read in a job-details panel: role summary, responsibilities, requirements, qualifications, experience, salary, employment type, benefits, location nuances.

Rules:
- Keep the author's own wording and bullet style; do not invent facts.
- STRIP site navigation ("Jobs", "My Profile", "Sign in", "Search by Keyword/Location", "Create Alert", category lists, province lists, cookie banners), repeated "Opens in a new tab" lines, legal boilerplate footers, "Apply now" buttons, and any mention of the source job board.
- If the posting is clearly closed, filled, expired, or the page is a redirect / 404 / nav-only shell, return exactly: NO_DESCRIPTION
- Output ONLY the cleaned description (plain text, blank line between sections, bullets with "• "). No preamble, no markdown headings.

POSTING TEXT:
${String(raw || '').slice(0, 7000)}`;
}
async function cleanDescriptionWithAI(raw, override) {
  const text = String(raw || '').trim();
  if (!text) return null;
  const out = await callScoringAI(buildDescriptionCleanupPrompt(text), override);
  if (!out) return null;
  const cleaned = tidyPlain(out).replace(/^```[a-z]*\s*|\s*```$/gi, '').trim();
  if (!cleaned || /^NO_DESCRIPTION\b/i.test(cleaned) || cleaned.length < 80) return null;
  return cleaned.slice(0, 8000);
}
// Pull the full job description for the in-app viewer. schema.org JobPosting
// embeds it in `description` (HTML) — the most reliable, zero-cost source.
// NOTE: do not route this through decodeEntities() — that helper collapses all
// whitespace (incl. newlines), which would destroy the description's layout.
function tidyPlain(s) {
  return String(s || '').replace(/\r/g, '')
    .replace(/[ \t]{2,}/g, ' ').replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n').trim();
}
function cleanHtml(s) {
  let t = String(s || '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|tr)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '• ')
    .replace(/<[^>]+>/g, ' ');
  t = t.replace(/&amp;/g, '&').replace(/&#x26;/gi, '&').replace(/&#38;/g, '&')
    .replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&#39;/g, "'").replace(/&apos;/gi, "'")
    .replace(/&nbsp;/g, ' ').replace(/&#160;/g, ' ')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&#x2013;/gi, '–').replace(/&#8211;/g, '–')
    .replace(/&#x2019;/gi, '’').replace(/&#8217;/g, '’');
  return tidyPlain(t);
}
function descriptionFromJsonLd(html) {
  const blocks = [...String(html || '').matchAll(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  for (const b of blocks) {
    let d; try { d = JSON.parse(b[1].trim()); } catch { continue; }
    const arr = Array.isArray(d) ? d : [d];
    for (const x of arr) {
      const items = (x && x['@graph']) ? x['@graph'] : [x];
      for (const it of items) {
        if (it && it.description && (it.hiringOrganization || /JobPosting/i.test(JSON.stringify(it['@type'] || '')))) {
          const txt = cleanHtml(it.description);
          if (txt) return txt.slice(0, 8000);
        }
      }
    }
  }
  return null;
}

function buildEmployerPrompt(text, url) {
  return `Below is the visible text of a single job posting (${url}). Identify the actual HIRING COMPANY / employer for this job — the company the job is FOR, NOT the job board or recruitment website, and NOT a generic label, button, or section heading. If the posting only names a recruitment agency acting for a client, use that agency name. If there is no clear company name, use null — never guess, and never fall back to the job board's own name.

Reply with ONLY a JSON object, no other text, in this exact shape:
{"company": "... or null"}

PAGE TEXT:
${String(text || '').slice(0, 4000)}`;
}

// Reads the real employer off a posting's own detail page. Used when the feed
// listing only gave a placeholder (e.g. Jobmail). Plain fetch + tag strip (no
// browser), AI-extracted, and never throws: any failure yields null.
async function resolveDetailFromPostingUrl(url, override) {
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; JobDiscoveryBot/1.0)', 'Accept': 'text/html' }
    });
    if (!res.ok) return null;
    const html = await res.text();

    // 1. schema.org JobPosting hiringOrganization — reliable and free.
    let cand = employerFromJsonLd(html);
    let description = descriptionFromJsonLd(html);

    // 2. Labelled "Employer:" marker in the visible text.
    const text = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ').trim();
    if ((!cand || isPlaceholderCompany(cand)) && text) {
      const patterns = [
        /\bEmployer\b[:\s]+([^|]{2,60}?)(?:\s{2,}|$)/gi,
        /\bRecruiter\b[:\s]+([^|]{2,60}?)(?:\s{2,}|$)/gi,
        /Posted[^|]*?\bby\s+([^|]{2,60}?)(?:\s{2,}|$)/gi
      ];
      for (const re of patterns) {
        let m;
        while ((m = re.exec(text)) !== null) {
          const c = decodeEntities(m[1]);
          if (c && !isPlaceholderCompany(c)) { cand = c; break; }
        }
        if (cand && !isPlaceholderCompany(cand)) break;
      }
    }

    // 3. AI last resort.
    if ((!cand || isPlaceholderCompany(cand)) && text) {
      const raw = await callScoringAI(buildEmployerPrompt(text, url), override);
      if (raw) {
        const cleaned = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
        let obj = null;
        try { obj = JSON.parse(cleaned); }
        catch { const m = cleaned.match(/\{[\s\S]*\}/); if (m) { try { obj = JSON.parse(m[0]); } catch { /* ignore */ } } }
        cand = (obj && obj.company != null) ? decodeEntities(String(obj.company)) : null;
      }
    }

    // No structured (JSON-LD) description? Run the visible text through AI
    // to strip nav/boilerplate and keep only job-relevant content. Returns
    // null for bounce/closed/filled pages so the viewer shows a friendly
    // fallback (or an external link, for Capitec) instead of garbage.
    if (!description && text) description = await cleanDescriptionWithAI(text, override);

    return {
      employer: (cand && !isPlaceholderCompany(cand)) ? cand : null,
      description: description || null
    };
  } catch {
    return { employer: null, description: null };
  }
}

/** Deterministic fallback used whenever AI is unavailable or returns bad data.
 * It only keeps jobs whose titles match one of the seeker's requested roles,
 * so a provider outage can never flood the dashboard with 0% records.
 */
function scoreJobsByTitle(jobs, userProfile) {
  return jobs
    .map(job => ({
      ...job,
      match_score: Math.round(jobFit.scoreTitle(job.title, userProfile.job_title_keywords) * 100)
    }))
    .filter(job => job.match_score > 30);
}

/**
 * Score jobs using the configured AI provider (shared key or seeker override)
 */
async function scoreJobsWithClaude(jobs, userProfile, override) {
  if (jobs.length === 0) return [];

  const provider = override?.provider || adminSettings?.ai_provider;
  const apiKey = override?.apiKey || adminSettings?.ai_api_key;

  // Never persist fake 0% matches. If AI is unavailable, use the strict
  // title matcher and discard unrelated jobs.
  if (!provider || provider === 'none' || !apiKey) {
    console.log(`  ⚠ No Agent API key — using deterministic title scoring`);
    return scoreJobsByTitle(jobs, userProfile);
  }

  const scored = [];

  for (let i = 0; i < jobs.length; i += BATCH_SIZE) {
    const batch = jobs.slice(i, i + BATCH_SIZE);

    try {
      const prompt = `You are a job matching expert. Score how well each job matches this user's profile.

User Profile:
- Name: ${userProfile.full_name}
- Job Titles Interested: ${(userProfile.job_title_keywords || []).join(', ') || 'Any'}
- Remote Only: ${userProfile.remote_only ? 'Yes' : 'No'}
- Location: South Africa
- Highest qualification: ${userProfile.highest_qualification || 'not stated'}
- Years of experience: ${userProfile.years_experience ?? 'not stated'}
- Current position: ${userProfile.current_position || 'not stated'}

${jobFit.hasApplyScope(userProfile)
  ? `IMPORTANT: this person has chosen which qualification levels (${(userProfile.apply_qualifications || []).join(', ') || 'any'}) and experience ranges (${(userProfile.apply_experience_ranges || []).join(', ') || 'any'} years) they want to apply for. Do NOT lower a score because a role looks senior or technical. Only score high when the job title is one of the titles they are interested in, or a very close variant.`
  : `IMPORTANT: score a job LOW (below 30) if its title is a more senior or more technical role than the profile supports (for example engineer, architect, scientist, senior, lead or manager roles when the person only has a matric, certificate or diploma). Only score high when the job title is one of the titles they are interested in, or a very close variant.`}

Jobs to score (0-100, higher = better match):
${batch.map((j, idx) => `
${idx + 1}. ${j.title}
   Company: ${j.company}
   Location: ${j.location}
   Remote: ${j.remote ? 'Yes' : 'No'}
   Description: ${j.description.substring(0, 200)}...
`).join('\n')}

Respond ONLY with JSON array of scores, e.g.: [85, 72, 91, ...]
No explanation, no markdown, just the array.`;

      const text = await callScoringAI(prompt, override);

      // Some providers occasionally wrap JSON in markdown code fences despite
      // being told not to — strip those before parsing (same defensive
      // handling aiMatch.js already uses for its own AI calls).
      const cleaned = (text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
      const scores = JSON.parse(cleaned);
      if (!Array.isArray(scores) || scores.length !== batch.length) {
        throw new Error(`AI returned ${Array.isArray(scores) ? scores.length : 'non-array'} scores for ${batch.length} jobs`);
      }

      batch.forEach((job, idx) => {
        const value = Number(scores[idx]);
        const fallback = Math.round(jobFit.scoreTitle(job.title, userProfile.job_title_keywords) * 100);
        scored.push({
          ...job,
          match_score: Number.isFinite(value) ? Math.max(0, Math.min(100, Math.round(value))) : fallback
        });
      });

      console.log(`  Scored batch ${Math.ceil((i + 1) / BATCH_SIZE)}/${Math.ceil(jobs.length / BATCH_SIZE)}`);

      // Rate limiting
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`❌ AI scoring failed for batch; using title fallback:`, err.message);
      scored.push(...scoreJobsByTitle(batch, userProfile));
    }
  }

  // Scores of 30% or below are not matches. Keep 31% and above, while still
  // preventing provider failures from creating 0% rows.
  return scored.filter(j => Number(j.match_score) > 30);
}

/**
 * Save matched jobs to database
 * Note: Uses job_seeker_id to match actual schema
 */
async function saveMatches(userId, matches, override) {
  if (matches.length === 0) {
    console.log(`  No matches to save for user ${userId}`);
    return 0;
  }

  // Resolve the REAL employer for each match. Adzuna/RemoteOK already carry it
  // in job.company; Jobmail only has the "Via Jobmail" placeholder, so for those
  // we read the hiring company off the posting's detail page. A placeholder
  // never becomes the stored employer (it would show as the company name).
  for (const job of matches) {
    // Prefer a substantial feed-provided description; otherwise read the
    // posting's own page (which also yields the real employer when the feed
    // only gave a placeholder like "Via Jobmail").
    const feedDesc = cleanHtml(job.description);
    const feedGood = feedDesc && feedDesc.length > 300 &&
      feedDesc.toLowerCase() !== String(job.title || '').toLowerCase();
    const needEmployer = isPlaceholderCompany(job.company);
    if (needEmployer || !feedGood) {
      const detail = await resolveDetailFromPostingUrl(job.url, override);
      job._employer = needEmployer ? (detail.employer || null) : String(job.company).trim();
      job._description = feedGood ? feedDesc : (detail.description || feedDesc || null);
    } else {
      job._employer = String(job.company).trim();
      job._description = feedDesc || null;
    }
  }

  const rows = matches.map(job => ({
    job_seeker_id: userId,
    job_source_id: job.job_source_id || null,
    job_title: job.title,
    company_name: job.company,
    // The real hiring company for the UI to display. Null when neither the feed
    // nor the posting page named a real company (UI then falls back gracefully).
    employer_name: job._employer || null,
    job_description: job._description || null,
    location: job.location,
    job_url: job.url,
    salary_text: job.salary_min && job.salary_max ? `R${job.salary_min}-${job.salary_max}` : null,
    match_score: parseInt(job.match_score) || 0,
    status: job.skip_reason ? 'skipped' : 'pending', // job_matches_status_check allows: pending, approved, rejected, applied, failed, needs_manual_action, seeker_paused, skipped
    skip_reason: job.skip_reason || null,
    discovered_at: new Date().toISOString(),
    match_reason: `Matched from ${job.source}`,
    is_custom_source: false,
    user_marked_applied: false
  }));

  // UNIQUE (job_seeker_id, job_url) — same URL for the same seeker is a duplicate; skip
  const { data, error } = await sb
    .from('job_matches')
    .upsert(rows, { onConflict: 'job_seeker_id,job_url', ignoreDuplicates: true })
    .select();

  if (error) {
    console.error(`❌ Save failed: ${error.message}`);
    return 0;
  }

  console.log(`  ✓ Saved ${data?.length || rows.length} matches for user ${userId}`);
  return data?.length || rows.length;
}

/**
 * Main discovery loop
 */
async function run() {
  console.log(`\n🚀 [discoverAuto] starting run at ${new Date().toISOString()}`);

  // Load admin settings / master switch
  const proceed = await loadAdminSettings();
  if (!proceed) return;

  // Check time window
  if (!isWithinTimeWindow()) {
    const { start_hour: s, end_hour: e, timezone: tz } = adminSettings;
    const shape = s === e ? '24/7' : (s > e ? `${s}:00→${e}:00 (overnight)` : `${s}:00-${e}:00`);
    console.log(`⏰ [discoverAuto] Outside configured time window (${shape} ${tz}). Skipping this run.`);
    return;
  }

  // Get all active users with auto-search enabled. discovery_mode 'both'
  // means "watched pages AND autonomous search" — it must be included here,
  // not just 'auto', or a seeker who picked "Both" in the admin panel
  // silently never gets autonomous board search at all.
  const { data: users, error: usersErr } = await sb
    .from('job_seekers')
    .select('*')
    .eq('status', 'active')
    .eq('auto_search_enabled', true)
    .in('discovery_mode', ['auto', 'both']);

  if (usersErr) {
    console.error('❌ [discoverAuto] Failed to load users:', usersErr.message);
    return;
  }

  console.log(`📋 Found ${users?.length || 0} users to process`);

  // Get all job sources
  const { data: allSources, error: sourcesErr } = await sb
    .from('job_sources')
    .select('*')
    .eq('active', true);

  if (sourcesErr || !allSources?.length) {
    console.error('❌ [discoverAuto] Failed to load job sources');
    return;
  }

  console.log(`📚 Available sources: ${allSources.map(s => s.name).join(', ')}`);

  let totalMatches = 0;

  for (const user of (users || [])) {
    console.log(`\n👤 Processing ${user.full_name} (${user.dedicated_email})`);

    // Get user's enabled sources
    const { data: userSources, error: userSourcesErr } = await sb
      .from('user_job_sources')
      .select('job_source_id, enabled')
      .eq('user_id', user.id)
      .eq('enabled', true);

    if (userSourcesErr || !userSources?.length) {
      console.log(`  ⚠ No enabled sources for user`);
      continue;
    }

    const enabledSourceIds = userSources.map(us => us.job_source_id);
    const enabledSources = allSources.filter(s => enabledSourceIds.includes(s.id));

    console.log(`  Sources enabled: ${enabledSources.map(s => s.name).join(', ')}`);

    let allJobs = [];

    // Fetch from all enabled sources
    for (const source of enabledSources) {
      const keywords = (user.job_title_keywords || []).join(' ') || 'software';
      const jobs = await fetchJobsFromSource(source, keywords);
      // Stamp the originating source id onto every job so saveMatches can
      // persist job_matches.job_source_id. This was previously left null,
      // which meant feed matches (e.g. Jobmail) were never linked back to
      // their source and any admin stat grouping matches by source
      // under-reported the feeds.
      jobs.forEach(j => { j.job_source_id = source.id; });
      allJobs = allJobs.concat(jobs);
    }

    // NOTE: watched pages (job_custom_sources) are intentionally NOT
    // re-fetched here — discoverWatched.js already handles those on its own
    // schedule for every active seeker regardless of discovery_mode. A
    // previous version of this file queried them here and logged their
    // names without doing anything else with them; that dead code has been
    // removed so this file doesn't look like it's processing watched pages
    // when it never was.

    if (allJobs.length === 0) {
      console.log(`  ℹ No jobs found from enabled sources`);
      continue;
    }

    console.log(`  📊 Total jobs fetched: ${allJobs.length}`);

    // Apply filters
    if (user.remote_only) {
      allJobs = allJobs.filter(j => j.remote);
      console.log(`  🌐 Filtered to remote only: ${allJobs.length} jobs`);
    }

    // Roles above the seeker's level are NOT dropped any more: they are scored like
    // any other job and, if they match, saved with status 'skipped' + a reason so the
    // user still sees them in Matches and can press Apply.
    allJobs.forEach(j => {
      const why = jobFit.titleSkipReason(j.title, user);
      if (why) { j.skip_reason = jobFit.skipMessage(why); }
    });

    // A seeker set to 'none' has deliberately opted out of AI entirely —
    // that must never silently fall back to the shared company key, so this
    // skips scoreJobsWithClaude altogether rather than passing it a null
    // override (which would fall through to the shared client internally).
    let scored;
    let userOverride = null;
    if (user.api_provider === 'none') {
      console.log(`  🚫 ${user.full_name} has AI access turned off — using deterministic title scoring`);
      scored = scoreJobsByTitle(allJobs, user);
    } else {
      // Bring-your-own-key: a seeker who opted into their own key gets scored
      // with it instead of the shared one. callScoringAI() now handles both
      // providers uniformly (see above), so this override works for an
      // OpenAI personal key exactly the same as an Anthropic one — it used
      // to only build a client for 'anthropic' and silently fall back to the
      // shared key/provider for 'openai', which meant a seeker's own OpenAI
      // key was never actually used here despite the admin panel offering it.
      if (user.api_provider === 'user' && user.ai_provider && user.ai_provider !== 'none' && user.ai_api_key) {
        userOverride = { provider: user.ai_provider, apiKey: user.ai_api_key, model: null };
      }

      // Score with the Agent
      console.log(`  Scoring with the Agent${userOverride ? ' (using their own API key)' : ''}...`);
      scored = await scoreJobsWithClaude(allJobs, user, userOverride);
    }

    // Save matches
    const saved = await saveMatches(user.id, scored, userOverride);
    totalMatches += saved;
  }

  console.log(`\n✅ [discoverAuto] run complete. Total matches: ${totalMatches}`);
}

module.exports = { run };

// Still runnable standalone for manual testing: `node discoverAuto.js`
if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => { console.error('💥 Fatal error:', err); process.exit(1); });
}
