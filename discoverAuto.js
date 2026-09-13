#!/usr/bin/env node
/**
 * discoverAuto.js - Autonomous Job Discovery Worker
 * Queries Adzuna & RemoteOK for each user's enabled sources
 * Scores matches with Claude API, saves to job_matches
 * Runs 8am-4pm SA time daily
 */

const { createClient } = require('@supabase/supabase-js');
const Anthropic = require('@anthropic-ai/sdk');

// Environment variables
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const ADZUNA_API_KEY = process.env.ADZUNA_API_KEY;

// Initialize clients
const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
const claude = new Anthropic({ apiKey: CLAUDE_API_KEY });

// Config
const SA_TIMEZONE = 'Africa/Johannesburg';
const MIN_HOUR = 8;  // 8am
const MAX_HOUR = 16; // 4pm (16:00)
const COUNTRY_FILTER = 'ZA';
const BATCH_SIZE = 5; // Jobs per batch for Claude scoring

/**
 * Check if current time is within 8am-4pm SA time
 */
function isWithinTimeWindow() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: SA_TIMEZONE,
    hour: '2-digit',
    hour12: false
  });
  const [hourStr] = formatter.format(now).split(':');
  const hour = parseInt(hourStr);
  return hour >= MIN_HOUR && hour < MAX_HOUR;
}

/**
 * Fetch jobs from Adzuna API
 */
async function fetchAdzunaJobs(userApiKey, query = 'software') {
  const apiKey = userApiKey || ADZUNA_API_KEY;
  if (!apiKey) {
    console.warn('⚠ Adzuna API key not available');
    return [];
  }

  try {
    const url = new URL('https://api.adzuna.com/v1/api/jobs/za/search');
    url.searchParams.append('app_id', '118cbf9d');
    url.searchParams.append('app_key', apiKey);
    url.searchParams.append('results_per_page', '50');
    url.searchParams.append('what', query);
    url.searchParams.append('where', 'ZA');
    url.searchParams.append('sort_by', 'date');

    const res = await fetch(url.toString());
    if (!res.ok) throw new Error(`Adzuna API error: ${res.status}`);

    const data = await res.json();
    console.log(`✓ Adzuna: fetched ${data.results?.length || 0} jobs`);

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
 * Fetch jobs from RemoteOK API
 */
async function fetchRemoteOKJobs(query = 'software') {
  try {
    const res = await fetch('https://remoteok.com/api');
    if (!res.ok) throw new Error(`RemoteOK API error: ${res.status}`);

    const jobs = await res.json();

    // Filter for ZA location and search query
    const filtered = (jobs || [])
      .filter(j =>
        (j.location?.includes('ZA') || j.location?.includes('South Africa') || j.company_logo?.includes('za')) &&
        (j.title?.toLowerCase().includes(query) || j.description?.toLowerCase().includes(query))
      )
      .slice(0, 50);

    console.log(`✓ RemoteOK: fetched ${filtered.length} jobs`);

    return filtered.map(job => ({
      source: 'remoteok',
      job_id: `remoteok_${job.id}`,
      title: job.title,
      company: job.company,
      location: job.location || 'Remote (ZA)',
      description: job.description || '',
      url: job.url,
      posted_at: new Date(job.date_posted * 1000).toISOString(),
      salary_min: job.salary_min,
      salary_max: job.salary_max,
      remote: true // RemoteOK is remote-only
    }));
  } catch (err) {
    console.error('❌ RemoteOK fetch failed:', err.message);
    return [];
  }
}

/**
 * Score jobs using Claude API
 */
async function scoreJobsWithClaude(jobs, userProfile) {
  if (jobs.length === 0) return [];

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
        model: 'claude-opus-4-1-20250805',
        max_tokens: 100,
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

  return scored.filter(j => j.match_score >= 50); // Only keep matches >= 50
}

/**
 * Save matched jobs to database
 */
async function saveMatches(userId, matches) {
  if (matches.length === 0) {
    console.log(`  No matches to save for user ${userId}`);
    return 0;
  }

  const rows = matches.map(job => ({
    user_id: userId,
    job_id: job.job_id,
    source: job.source,
    title: job.title,
    company: job.company,
    location: job.location,
    description: job.description.substring(0, 1000),
    url: job.url,
    match_score: job.match_score,
    salary_min: job.salary_min,
    salary_max: job.salary_max,
    remote: job.remote,
    posted_at: job.posted_at,
    discovered_at: new Date().toISOString()
  }));

  const { data, error } = await sb
    .from('job_matches')
    .upsert(rows, { onConflict: 'job_id,user_id' });

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

  // Check time window (bypass with SKIP_TIME_CHECK=true for manual testing)
  const skipTimeCheck = process.env.SKIP_TIME_CHECK === 'true';
  if (skipTimeCheck) {
    console.log('⚠ SKIP_TIME_CHECK=true — bypassing 8am-4pm SA window check.');
  } else if (!isWithinTimeWindow()) {
    console.log('⏰ Outside 8am-4pm SA window. Exiting.');
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

  let totalMatches = 0;

  for (const user of (users || [])) {
    console.log(`\n👤 Processing ${user.full_name} (${user.dedicated_email})`);

    // Get user's enabled sources
    const { data: userSources, error: sourcesErr } = await sb
      .from('user_job_sources_view')
      .select('source_id,source_name,source_enabled')
      .eq('user_id', user.id)
      .eq('source_enabled', true);

    if (sourcesErr || !userSources?.length) {
      console.log(`  ⚠ No enabled sources for user`);
      continue;
    }

    console.log(`  Sources enabled: ${userSources.map(s => s.source_name).join(', ')}`);

    let allJobs = [];

    // Fetch from enabled sources
    for (const src of userSources) {
      if (src.source_name === 'Adzuna') {
        const apiKey = user.api_provider === 'user' ? user.api_key : null;
        const keywords = (user.job_title_keywords || []).join(' ') || 'software';
        const jobs = await fetchAdzunaJobs(apiKey, keywords);
        allJobs = allJobs.concat(jobs);
      } else if (src.source_name === 'RemoteOK') {
        const keywords = (user.job_title_keywords || []).join(' ') || 'software';
        const jobs = await fetchRemoteOKJobs(keywords);
        allJobs = allJobs.concat(jobs);
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
