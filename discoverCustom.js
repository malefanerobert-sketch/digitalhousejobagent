require('dotenv').config();
const supabase = require('./supabaseClient');
const aiMatch = require('./aiMatch');

// Each of these platforms publishes a public, unauthenticated JSON feed of
// open roles for any company using them. This is the safest, most reliable
// way to discover jobs — it's not scraping a page, it's reading a feed the
// platform intends to be read programmatically.

async function fetchGreenhouseJobs(boardToken) {
  const url = `https://boards-api.greenhouse.io/v1/boards/${boardToken}/jobs?content=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Greenhouse fetch failed for ${boardToken}: ${res.status}`);
  const data = await res.json();
  return (data.jobs || []).map(j => ({
    job_title: j.title,
    company_name: boardToken,
    job_url: j.absolute_url,
    location: j.location?.name || null,
    raw_text: (j.content || '').replace(/<[^>]+>/g, ' ').slice(0, 4000)
  }));
}

async function fetchLeverJobs(company) {
  const url = `https://api.lever.co/v0/postings/${company}?mode=json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Lever fetch failed for ${company}: ${res.status}`);
  const data = await res.json();
  return (data || []).map(j => ({
    job_title: j.text,
    company_name: company,
    job_url: j.hostedUrl,
    location: j.categories?.location || null,
    raw_text: (j.descriptionPlain || '').slice(0, 4000)
  }));
}

async function fetchAshbyJobs(jobBoardName) {
  const url = `https://api.ashbyhq.com/posting-api/job-board/${jobBoardName}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Ashby fetch failed for ${jobBoardName}: ${res.status}`);
  const data = await res.json();
  return (data.jobs || []).map(j => ({
    job_title: j.title,
    company_name: jobBoardName,
    job_url: j.jobUrl || j.applyUrl,
    location: j.location || null,
    raw_text: (j.descriptionPlain || j.description || '').replace(/<[^>]+>/g, ' ').slice(0, 4000)
  }));
}

async function fetchSmartRecruitersJobs(company) {
  const url = `https://api.smartrecruiters.com/v1/companies/${company}/postings`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`SmartRecruiters fetch failed for ${company}: ${res.status}`);
  const data = await res.json();
  return (data.content || []).map(j => ({
    job_title: j.name,
    company_name: company,
    job_url: j.applyUrl || j.postingUrl || `https://jobs.smartrecruiters.com/${company}/${j.id}`,
    location: j.location?.city ? `${j.location.city}${j.location.country ? ', ' + j.location.country : ''}` : null,
    raw_text: (j.jobAd?.sections?.jobDescription?.text || '').replace(/<[^>]+>/g, ' ').slice(0, 4000)
  }));
}

async function fetchWorkableJobs(account) {
  const url = `https://apply.workable.com/api/v1/widget/accounts/${account}?details=true`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Workable fetch failed for ${account}: ${res.status}`);
  const data = await res.json();
  return (data.jobs || []).map(j => ({
    job_title: j.title,
    company_name: account,
    job_url: j.url || `https://apply.workable.com/${account}/j/${j.shortcode}/`,
    location: j.location?.city ? `${j.location.city}${j.location.country ? ', ' + j.location.country : ''}` : null,
    raw_text: (j.description || '').replace(/<[^>]+>/g, ' ').slice(0, 4000)
  }));
}

// Very simple keyword match score: fraction of the seeker's keywords found
// in the job title + description. Good enough starting point — can be swapped
// for something smarter (embeddings, AI scoring) later without touching the schema.
function scoreMatch(job, keywords) {
  if (!keywords || keywords.length === 0) return 0;
  const haystack = `${job.job_title} ${job.raw_text}`.toLowerCase();
  const hits = keywords.filter(k => haystack.includes(k.toLowerCase())).length;
  return hits / keywords.length;
}

async function run() {
  console.log(`[discover] starting run at ${new Date().toISOString()}`);

  await aiMatch.loadSettings(supabase);
  console.log(`[discover] AI-powered matching: ${aiMatch.isEnabled() ? 'ON (shared DigitalHouse key)' : 'OFF (keyword matching only — set it in Dispatch Admin > AI settings)'}`);

  const { data: sources, error: srcErr } = await supabase
    .from('job_sources')
    .select('*')
    .eq('active', true)
    .in('source_type', ['greenhouse', 'lever', 'ashby', 'smartrecruiters', 'workable']);

  if (srcErr) { console.error('[discover] failed to load job_sources:', srcErr.message); return; }
  if (!sources || sources.length === 0) {
    console.log('[discover] no active sources configured yet — add rows to job_sources first.');
    return;
  }

  const { data: seekers, error: seekErr } = await supabase
    .from('job_seekers')
    .select('*')
    .eq('status', 'active');

  if (seekErr) { console.error('[discover] failed to load job_seekers:', seekErr.message); return; }
  if (!seekers || seekers.length === 0) {
    console.log('[discover] no active job_seekers yet — nothing to match against.');
    return;
  }

  for (const source of sources) {
    let jobs = [];
    try {
      // base_url for these rows is expected to hold just the company/board token,
      // set when the source row is created.
      if (source.source_type === 'greenhouse') jobs = await fetchGreenhouseJobs(source.base_url);
      if (source.source_type === 'lever') jobs = await fetchLeverJobs(source.base_url);
      if (source.source_type === 'ashby') jobs = await fetchAshbyJobs(source.base_url);
      if (source.source_type === 'smartrecruiters') jobs = await fetchSmartRecruitersJobs(source.base_url);
      if (source.source_type === 'workable') jobs = await fetchWorkableJobs(source.base_url);
    } catch (err) {
      console.error(`[discover] error fetching ${source.name}:`, err.message);
      continue;
    }

    console.log(`[discover] ${source.name}: ${jobs.length} open roles fetched`);

    for (const seeker of seekers) {
      for (const job of jobs) {
        const keywordScore = scoreMatch(job, seeker.job_title_keywords);
        if (keywordScore < 0.4) continue; // cheap pre-filter before any AI call

        // avoid duplicate matches for the same seeker + job_url
        const { data: existing } = await supabase
          .from('job_matches')
          .select('id')
          .eq('job_seeker_id', seeker.id)
          .eq('job_url', job.job_url)
          .maybeSingle();

        if (existing) continue;

        let finalScore = keywordScore;
        let matchReason = null;

        if (aiMatch.isEnabled()) {
          const aiResult = await aiMatch.scoreWithAI(seeker.resume_text, job);
          if (aiResult) {
            finalScore = aiResult.score;
            matchReason = aiResult.reason;
          }
          // if aiResult is null (API error), we silently keep the keyword score — no interruption
        }

        if (finalScore < 0.4) {
          console.log(`[discover] AI downgraded "${job.job_title}" for ${seeker.full_name} below threshold — skipping`);
          continue;
        }

        const { error: insErr } = await supabase.from('job_matches').insert({
          job_seeker_id: seeker.id,
          job_source_id: source.id,
          job_title: job.job_title,
          company_name: job.company_name,
          job_url: job.job_url,
          location: job.location,
          match_score: Number(finalScore.toFixed(2)),
          match_reason: matchReason,
          status: 'pending'
        });

        if (insErr) console.error('[discover] insert failed:', insErr.message);
        else console.log(`[discover] new match: "${job.job_title}" @ ${job.company_name} for ${seeker.full_name} (score ${finalScore.toFixed(2)}${matchReason ? ' — ' + matchReason : ''})`);
      }
    }
  }

  console.log('[discover] run complete');
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
