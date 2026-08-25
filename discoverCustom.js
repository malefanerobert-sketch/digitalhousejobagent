require('dotenv').config();
const { chromium } = require('playwright');
const supabase = require('./supabaseClient');

const EXTRACT_PROMPT = (pageText) => `You are extracting job listings from a company careers page's text content. Below is the visible text scraped from the page.

List every distinct job opening you can find. For each one, give the job title and, if visible, the location. Ignore navigation menus, footers, and unrelated content.

PAGE TEXT:
${pageText.slice(0, 8000)}

Reply with ONLY a JSON array, no other text, in this exact shape:
[{"job_title": "...", "location": "..." }]
If you find no clear job listings, reply with an empty array: []`;

async function extractWithAnthropic(apiKey, pageText) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1500,
    messages: [{ role: 'user', content: EXTRACT_PROMPT(pageText) }]
  });
  return msg.content?.[0]?.text || '[]';
}

async function extractWithOpenAI(apiKey, pageText) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 1500,
      messages: [{ role: 'user', content: EXTRACT_PROMPT(pageText) }]
    })
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '[]';
}

async function run() {
  console.log(`[discoverCustom] starting run at ${new Date().toISOString()}`);

  const { data: sources, error } = await supabase
    .from('job_custom_sources')
    .select('*, job_seekers(*)')
    .eq('active', true);

  if (error) { console.error('[discoverCustom] failed to load job_custom_sources:', error.message); return; }
  if (!sources || sources.length === 0) { console.log('[discoverCustom] no custom sources configured yet'); return; }

  const browser = await chromium.launch({ headless: true });

  for (const src of sources) {
    const seeker = src.job_seekers;
    if (!seeker || seeker.ai_provider === 'none' || !seeker.ai_api_key) {
      console.log(`[discoverCustom] skipping "${src.company_name}" for ${seeker?.full_name || 'unknown'} — no AI key configured, can't extract unstructured pages`);
      continue;
    }

    console.log(`[discoverCustom] checking ${src.company_name} (${src.career_page_url}) for ${seeker.full_name}`);
    const page = await browser.newPage();
    try {
      await page.goto(src.career_page_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      const pageText = await page.innerText('body').catch(() => '');

      let raw;
      if (seeker.ai_provider === 'anthropic') raw = await extractWithAnthropic(seeker.ai_api_key, pageText);
      else if (seeker.ai_provider === 'openai') raw = await extractWithOpenAI(seeker.ai_api_key, pageText);
      else continue;

      let jobs = [];
      try { jobs = JSON.parse(raw.trim()); } catch (_) { jobs = []; }

      for (const job of jobs) {
        if (!job.job_title) continue;

        const { data: existing } = await supabase
          .from('job_matches')
          .select('id')
          .eq('job_seeker_id', seeker.id)
          .eq('job_title', job.job_title)
          .eq('company_name', src.company_name)
          .maybeSingle();
        if (existing) continue;

        await supabase.from('job_matches').insert({
          job_seeker_id: seeker.id,
          job_title: job.job_title,
          company_name: src.company_name,
          job_url: src.career_page_url,
          location: job.location || null,
          match_score: null,
          match_reason: 'Found on the career page you added — review and apply directly, the agent doesn\'t auto-submit here.',
          status: 'pending',
          is_custom_source: true
        });
        console.log(`[discoverCustom]  new listing: "${job.job_title}" @ ${src.company_name}`);
      }

      await supabase.from('job_custom_sources').update({ last_checked_at: new Date().toISOString() }).eq('id', src.id);
    } catch (err) {
      console.error(`[discoverCustom] error checking ${src.company_name}:`, err.message);
    } finally {
      await page.close();
    }
  }

  await browser.close();
  console.log('[discoverCustom] run complete');
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
