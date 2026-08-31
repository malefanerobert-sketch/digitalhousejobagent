// AI-powered match scoring. Previously each user brought their OWN key —
// that model is retired. Dispatch now runs on ONE shared DigitalHouse-owned
// key, managed by Dispatch Admin and stored in the `dispatch_settings`
// table (a single row, id=true). Users never see or manage this — cost is
// recovered through their subscription, not billed to individual accounts.
//
// Call loadSettings(supabase) once at the start of a run to populate the
// in-memory cache, then isEnabled()/scoreWithAI() use that cache for the
// rest of the run — avoids re-querying Supabase for every single job.

let cachedSettings = null;

async function loadSettings(supabase) {
  const { data, error } = await supabase
    .from('dispatch_settings')
    .select('ai_provider, ai_api_key, ai_model')
    .eq('id', true)
    .maybeSingle();
  if (error) {
    console.error('[ai-match] failed to load dispatch_settings, AI matching disabled for this run:', error.message);
    cachedSettings = { ai_provider: 'none', ai_api_key: null, ai_model: null };
  } else {
    cachedSettings = data || { ai_provider: 'none', ai_api_key: null, ai_model: null };
  }
  return cachedSettings;
}

// Used only if Dispatch Admin hasn't set a specific model string — keeps
// the app working out of the box, but Admin's own choice always wins.
const DEFAULT_MODEL = { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini' };
function currentModel() {
  return cachedSettings?.ai_model || DEFAULT_MODEL[cachedSettings?.ai_provider] || null;
}

function isEnabled() {
  return !!(cachedSettings?.ai_provider && cachedSettings.ai_provider !== 'none' && cachedSettings.ai_api_key);
}

const PROMPT_TEMPLATE = (resumeText, job) => `You are helping score how well a candidate fits a job posting for an automated job-application tool. Be a realistic, not overly generous, judge.

CANDIDATE RESUME:
${(resumeText || '').slice(0, 3000)}

JOB TITLE: ${job.job_title}
COMPANY: ${job.company_name}
JOB DESCRIPTION:
${(job.raw_text || '').slice(0, 3000)}

Reply with ONLY a JSON object, no other text, in this exact shape:
{"score": <number between 0 and 1>, "reason": "<one short sentence explaining the score>"}`;

async function scoreWithAnthropic(apiKey, model, resumeText, job) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model,
    max_tokens: 200,
    messages: [{ role: 'user', content: PROMPT_TEMPLATE(resumeText, job) }]
  });
  return msg.content?.[0]?.text || '';
}

async function scoreWithOpenAI(apiKey, model, resumeText, job) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      max_tokens: 200,
      messages: [{ role: 'user', content: PROMPT_TEMPLATE(resumeText, job) }]
    })
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

// Returns { score: 0-1, reason: string } or null on failure/disabled (caller
// should fall back to keyword score if this returns null).
async function scoreWithAI(resumeText, job) {
  if (!isEnabled()) return null;
  const model = currentModel();

  try {
    let text;
    if (cachedSettings.ai_provider === 'anthropic') {
      text = await scoreWithAnthropic(cachedSettings.ai_api_key, model, resumeText, job);
    } else if (cachedSettings.ai_provider === 'openai') {
      text = await scoreWithOpenAI(cachedSettings.ai_api_key, model, resumeText, job);
    } else {
      return null; // unknown provider, silently skip
    }

    // Some providers occasionally wrap JSON in markdown code fences — strip those.
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.score !== 'number') return null;
    return { score: Math.max(0, Math.min(1, parsed.score)), reason: parsed.reason || '' };
  } catch (err) {
    console.error(`[ai-match] scoring failed (${cachedSettings.ai_provider}/${model}), will fall back to keyword score:`, err.message);
    return null;
  }
}

// Generic text-completion helper for the Watched Pages feature (extracting
// job listings from raw HTML) — same shared key + chosen model, different
// kind of prompt.
async function completeWithAI(prompt) {
  if (!isEnabled()) return null;
  const model = currentModel();
  try {
    if (cachedSettings.ai_provider === 'anthropic') {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey: cachedSettings.ai_api_key });
      const msg = await client.messages.create({
        model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });
      return msg.content?.[0]?.text || '';
    } else if (cachedSettings.ai_provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${cachedSettings.ai_api_key}` },
        body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
      });
      if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    }
    return null;
  } catch (err) {
    console.error(`[ai-match] completeWithAI failed (${cachedSettings.ai_provider}/${model}):`, err.message);
    return null;
  }
}

module.exports = { loadSettings, isEnabled, scoreWithAI, completeWithAI };
