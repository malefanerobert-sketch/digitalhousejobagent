// AI-powered match scoring, with support for multiple providers. Each user
// brings their OWN key (Anthropic, OpenAI, or Gemini) via their profile — this
// module never uses a shared/global key, only what's stored on
// job_seekers.ai_provider and job_seekers.ai_api_key for that specific user.
// If a user hasn't set a provider (or set 'none'), callers should just use
// the plain keyword score — this module makes that easy to check per-seeker.

function isEnabled(seeker) {
  return !!(seeker?.ai_provider && seeker.ai_provider !== 'none' && seeker?.ai_api_key);
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

async function scoreWithAnthropic(apiKey, resumeText, job) {
  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 200,
    messages: [{ role: 'user', content: PROMPT_TEMPLATE(resumeText, job) }]
  });
  return msg.content?.[0]?.text || '';
}

async function scoreWithOpenAI(apiKey, resumeText, job) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      max_tokens: 200,
      messages: [{ role: 'user', content: PROMPT_TEMPLATE(resumeText, job) }]
    })
  });
  if (!res.ok) throw new Error(`OpenAI API error: ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function scoreWithGemini(apiKey, resumeText, job) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: PROMPT_TEMPLATE(resumeText, job) }] }]
    })
  });
  if (!res.ok) throw new Error(`Gemini API error: ${res.status}`);
  const data = await res.json();
  return data.candidates?.[0]?.content?.parts?.[0]?.text || '';
}

// Returns { score: 0-1, reason: string } or null on failure/disabled (caller
// should fall back to keyword score if this returns null).
async function scoreWithAI(seeker, job) {
  if (!isEnabled(seeker)) return null;

  try {
    let text;
    if (seeker.ai_provider === 'anthropic') {
      text = await scoreWithAnthropic(seeker.ai_api_key, seeker.resume_text, job);
    } else if (seeker.ai_provider === 'openai') {
      text = await scoreWithOpenAI(seeker.ai_api_key, seeker.resume_text, job);
    } else if (seeker.ai_provider === 'gemini') {
      text = await scoreWithGemini(seeker.ai_api_key, seeker.resume_text, job);
    } else {
      return null; // unknown provider, silently skip
    }

    // Gemini/OpenAI sometimes wrap JSON in markdown code fences — strip those.
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const parsed = JSON.parse(cleaned);
    if (typeof parsed.score !== 'number') return null;
    return { score: Math.max(0, Math.min(1, parsed.score)), reason: parsed.reason || '' };
  } catch (err) {
    console.error(`[ai-match] scoring failed for ${seeker.full_name} (${seeker.ai_provider}), will fall back to keyword score:`, err.message);
    return null;
  }
}

module.exports = { isEnabled, scoreWithAI };
