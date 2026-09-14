#!/usr/bin/env node
/**
 * discoverAuto.js - Autonomous Job Discovery Worker
 * Queries ALL enabled job sources for each user
 * Time window configurable by admin via dispatch_settings
 * Scores matches with Claude API, saves to job_matches
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

// Environment variables (env takes precedence; DB values fill in gaps)
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
// Adzuna's app_id is a public identifier (not a secret); default to the one
// registered for this project so Railway only has to hold the secret app_key.
// Override with ADZUNA_APP_ID if you register a different Adzuna app later.
const ADZUNA_APP_ID = process.env.ADZUNA_APP_ID || '118cbf9d';
const ADZUNA_API_KEY = process.env.ADZUNA_API_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('❌ SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Anthropic client is initialized after loadAdminSettings() runs, so it can
// pick up the API key stored in dispatch_settings when no env var is set.
let claude = null;

// Config
const SA_TIMEZONE = 'Africa/Johannesburg';
const COUNTRY_FILTER = 'ZA';
const BATCH_SIZE = 5; // Jobs per batch for Claude scoring
const DEFAULT_CLAUDE_MODEL = 'claude-sonnet-4-5-20250929';

let adminSettings = null; // Will be loaded from DB

/**
 * Load admin settings (time window, timezone, etc)
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
      ai_model: data.ai_model || DEFAULT_CLAUDE_MODEL
    };
    console.log(`⏰ Admin time window: ${adminSettings.start_hour}:00 - ${adminSettings.end_hour}:00 ${adminSettings.timezone}`);
    console.log(`🎛  Agent master switch: ${adminSettings.enabled ? 'ON' : 'OFF'}`);
    console.log(`🤖 AI model: ${adminSettings.ai_model} (key ${adminSettings.ai_api_key ? 'present' : 'MISSING'})`);
  }

  // Master switch check
  if (!adminSettings.enabled && process.env.SKIP_ENABLED_CHECK !== 'true') {
    console.log('🛑 Agent master switch is OFF (dispatch_settings.agent_enabled=false). Exiting.');
    process.exit(0);
  }

  // Initialize Anthropic client with the resolved key
  if (adminSettings.ai_api_key) {
    claude = new Anthropic({ apiKey: adminSettings.ai_api_key });
  } else {
    console.warn('⚠ No Claude API key available — scoring will be skipped, jobs will save with score=0');
  }
}

/**
 * Check if current time is within admin-configured time window
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

  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: adminSettings.timezone,
    hour: '2-digit',
    hour12: false
  });
  const [hourStr] = formatter.format(now).split(':');
  const hour = parseInt(hourStr);
  return hour >= adminSettings.start_hour && hour < adminSettings.end_hour;
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
      url: job.redirect_url,
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
 * Score jobs using Claude API
 */
async function scoreJobsWithClaude(jobs, userProfile) {
  if (jobs.length === 0) return [];

  // If no Claude client, save every job with a placeholder score (unscored)
  if (!claude) {
    console.log(`  ⚠ No Claude key — saving ${jobs.length} jobs unscored (score=0)`);
    return jobs.map(j => ({ ...j, match_score: 0 }));
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

      const response = await claude.messages.create({
        model: adminSettings.ai_model || DEFAULT_CLAUDE_MODEL,
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      });

      const scoreStr = response.content[0].text.trim();
      const scores = JSON.parse(scoreStr);

      batch.forEach((job, idx) => {
        scored.push({
          ...job,
          match_score: scores[idx] || 0
        });
      });

      console.log(`  Scored batch ${Math.ceil((i + 1) / BATCH_SIZE)}/${Math.ceil(jobs.length / BATCH_SIZE)}`);

      // Rate limiting
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error(`❌ Claude scoring failed for batch:`, err.message);
      batch.forEach(job => {
        scored.push({ ...job, match_score: 0 });
      });
    }
  }

  // Only keep matches >= 50 when we actually scored; otherwise keep everything
  const anyScored = scored.some(j => j.match_score > 0);
  return anyScored ? scored.filter(j => j.match_score >= 50) : scored;
}

/**
 * Save matched jobs to database
 * Note: Uses job_seeker_id to match actual schema
 */
async function saveMatches(userId, matches) {
  if (matches.length === 0) {
    console.log(`  No matches to save for user ${userId}`);
    return 0;
  }

  const rows = matches.map(job => ({
    job_seeker_id: userId,
    job_title: job.title,
    company_name: job.company,
    location: job.location,
    job_url: job.url,
    salary_text: job.salary_min && job.salary_max ? `R${job.salary_min}-${job.salary_max}` : null,
    match_score: parseInt(job.match_score) || 0,
    status: 'pending', // job_matches_status_check allows: pending, approved, rejected, applied, failed, needs_manual_action, seeker_paused
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
async function discoverForAllUsers() {
  console.log('\n🚀 Starting autonomous discovery...');

  // Load admin settings
  await loadAdminSettings();

  // Check time window
  if (!isWithinTimeWindow()) {
    console.log(`⏰ Outside configured time window (${adminSettings.start_hour}:00-${adminSettings.end_hour}:00 ${adminSettings.timezone}). Exiting.`);
    process.exit(0);
  }

  // Get all active users with auto-search enabled
  const { data: users, error: usersErr } = await sb
    .from('job_seekers')
    .select('*')
    .eq('status', 'active')
    .eq('auto_search_enabled', true)
    .eq('discovery_mode', 'auto');

  if (usersErr) {
    console.error('❌ Failed to load users:', usersErr.message);
    process.exit(1);
  }

  console.log(`📋 Found ${users?.length || 0} users to process`);

  // Get all job sources
  const { data: allSources, error: sourcesErr } = await sb
    .from('job_sources')
    .select('*')
    .eq('active', true);

  if (sourcesErr || !allSources?.length) {
    console.error('❌ Failed to load job sources');
    process.exit(1);
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
      allJobs = allJobs.concat(jobs);
    }

    // Also fetch from custom user-added sources if they have any
    const { data: customSources, error: customErr } = await sb
      .from('job_custom_sources')
      .select('*')
      .eq('job_seeker_id', user.id)
      .eq('active', true);

    if (!customErr && customSources?.length) {
      console.log(`  Custom sources: ${customSources.map(s => s.company_name).join(', ')}`);
      for (const customSource of customSources) {
        // Custom sources are just URLs - user has manually added them
        // Store them as a note that custom sources were considered
        console.log(`    ℹ Custom source: ${customSource.company_name} (${customSource.career_page_url})`);
      }
    }

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

    // Score with Claude
    console.log(`  🤖 Scoring with Claude...`);
    const scored = await scoreJobsWithClaude(allJobs, user);

    // Save matches
    const saved = await saveMatches(user.id, scored);
    totalMatches += saved;
  }

  console.log(`\n✅ Discovery complete. Total matches: ${totalMatches}`);
  process.exit(0);
}

// Run
discoverForAllUsers().catch(err => {
  console.error('💥 Fatal error:', err);
  process.exit(1);
});
