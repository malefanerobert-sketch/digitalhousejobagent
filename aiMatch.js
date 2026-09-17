// AI-powered match scoring. Historically each user brought their OWN key —
// that model was retired in favor of ONE shared DigitalHouse-owned key,
// managed by Dispatch Admin and stored in the `dispatch_settings` table (a
// single row, id=true). Per-seeker keys came back on 2026-09-17 as an
// OPT-IN override: when job_seekers.api_provider = 'user' and that seeker
// has set their own ai_provider/ai_api_key, their AI calls use THEIR key
// instead of the shared one (see resolveSeekerOverride below) — so a
// seeker's own usage stops billing to the shared key. Every caller that
// wants this resolves the seeker's override and passes it into
// scoreWithAI()/completeWithAI(); pass nothing and the shared key is used
// exactly as before.
//
// Call loadSettings(supabase) once at the start of a run to populate the
// in-memory cache, then isAgentEnabled()/isEnabled()/scoreWithAI() use that
// cache for the rest of the run — avoids re-querying Supabase for every
// single job.

let cachedSettings = null;

async function loadSettings(supabase) {
  const { data, error } = await supabase
    .from('dispatch_settings')
    .select('ai_provider, ai_api_key, ai_model, agent_prompt, agent_enabled')
    .eq('id', true)
    .maybeSingle();
  if (error) {
    console.error('[ai-match] failed to load dispatch_settings, AI matching disabled for this run:', error.message);
    cachedSettings = { ai_provider: 'none', ai_api_key: null, ai_model: null, agent_prompt: null, agent_enabled: true };
  } else {
    cachedSettings = data || { ai_provider: 'none', ai_api_key: null, ai_model: null, agent_prompt: null, agent_enabled: true };
  }
  return cachedSettings;
}

// Dispatch Admin's free-text "Agent instructions" — prepended to prompts
// that benefit from admin-tunable guidance (currently just watched-page
// extraction). Returns null when nothing has been set.
function agentPrompt() {
  return cachedSettings?.agent_prompt || null;
}

// Used only if Dispatch Admin hasn't set a specific model string — keeps
// the app working out of the box, but Admin's own choice always wins. An
// override never carries its own model preference today, so this always
// falls through to the shared default — kept as a parameter so a future
// per-seeker model choice has somewhere to plug in.
const DEFAULT_MODEL = { anthropic: 'claude-haiku-4-5-20251001', openai: 'gpt-4o-mini' };
function currentModel(override) {
  if (override?.model) return override.model;
  return cachedSettings?.ai_model || DEFAULT_MODEL[cachedSettings?.ai_provider] || null;
}

// Is the shared company key configured? Independent of whether the admin's
// master switch is on — see isAgentEnabled() for that.
function isEnabled() {
  return !!(cachedSettings?.ai_provider && cachedSettings.ai_provider !== 'none' && cachedSettings.ai_api_key);
}

// Dispatch Admin's master on/off switch (dispatch_settings.agent_enabled).
// This is the thing the admin panel's "Turn Agent OFF" button controls —
// every worker file that runs discovery or applies on a seeker's behalf
// must check this before doing anything. Fails OPEN (treated as on) if the
// column can't be read, matching discoverAuto.js's long-standing default:
// a transient read glitch shouldn't silently stop the whole product.
function isAgentEnabled() {
  return cachedSettings?.agent_enabled !== false;
}

// Resolves a per-seeker AI override: when that seeker has opted into their
// own key (job_seekers.api_provider === 'user') and has actually set a
// provider + key, calls should use THEIRS instead of the shared one — this
// is what makes "bring your own API key" actually do something, instead of
// just saving to columns nothing reads. Returns null when the seeker should
// use the shared key (the normal, default case).
function resolveSeekerOverride(seeker) {
  if (!seeker) return null;
  if (seeker.api_provider !== 'user') return null;
  if (!seeker.ai_provider || seeker.ai_provider === 'none') return null;
  if (!seeker.ai_api_key) return null;
  return { provider: seeker.ai_provider, apiKey: seeker.ai_api_key, model: null };
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
// should fall back to keyword score if this returns null). Pass a resolved
// seeker override to use their own key/provider instead of the shared one.
async function scoreWithAI(resumeText, job, override) {
  const provider = override?.provider || cachedSettings?.ai_provider;
  const apiKey = override?.apiKey || cachedSettings?.ai_api_key;
  if (!provider || provider === 'none' || !apiKey) return null;
  const model = currentModel(override);

  try {
    let text;
    if (provider === 'anthropic') {
      text = await scoreWithAnthropic(apiKey, model, resumeText, job);
    } else if (provider === 'openai') {
      text = await scoreWithOpenAI(apiKey, model, resumeText, job);
    } else {
      return null; // unknown provider, silently skip
    }

    // Some providers occasionally wrap JSON in markdown code fences — strip those.
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.score !== 'number') return null;
    return { score: Math.max(0, Math.min(1, parsed.score)), reason: parsed.reason || '' };
  } catch (err) {
    console.error(`[ai-match] scoring failed (${provider}/${model}), will fall back to keyword score:`, err.message);
    return null;
  }
}

// Generic text-completion helper for the Watched Pages feature (extracting
// job listings from raw HTML) and application field-mapping — same shape as
// scoreWithAI: pass a resolved seeker override to use their own key.
async function completeWithAI(prompt, override) {
  const provider = override?.provider || cachedSettings?.ai_provider;
  const apiKey = override?.apiKey || cachedSettings?.ai_api_key;
  if (!provider || provider === 'none' || !apiKey) return null;
  const model = currentModel(override);
  try {
    if (provider === 'anthropic') {
      const Anthropic = require('@anthropic-ai/sdk');
      const client = new Anthropic({ apiKey });
      const msg = await client.messages.create({
        model,
        max_tokens: 2000,
        messages: [{ role: 'user', content: prompt }]
      });
      return msg.content?.[0]?.text || '';
    } else if (provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
        body: JSON.stringify({ model, max_tokens: 2000, messages: [{ role: 'user', content: prompt }] })
      });
      if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
      const data = await res.json();
      return data.choices?.[0]?.message?.content || '';
    }
    return null;
  } catch (err) {
    console.error(`[ai-match] completeWithAI failed (${provider}/${model}):`, err.message);
    return null;
  }
}

module.exports = { loadSettings, isEnabled, isAgentEnabled, resolveSeekerOverride, scoreWithAI, completeWithAI, agentPrompt };
