// Optional upgrade to job matching. If ANTHROPIC_API_KEY is set, this asks
// Claude to judge fit between a resume and a job description, returning a
// score + a short reason. If no key is set, callers should just use the
// plain keyword score instead — this module makes that easy to check.

const hasKey = !!process.env.ANTHROPIC_API_KEY;
let Anthropic = null;
let client = null;

if (hasKey) {
  Anthropic = require('@anthropic-ai/sdk');
  client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
}

function isEnabled() {
  return hasKey;
}

// Returns { score: 0-1, reason: string } or null on failure (caller should
// fall back to keyword score if this returns null).
async function scoreWithAI(resumeText, job) {
  if (!hasKey) return null;

  try {
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content: `You are helping score how well a candidate fits a job posting for an automated job-application tool. Be a realistic, not overly generous, judge.

CANDIDATE RESUME:
${(resumeText || '').slice(0, 3000)}

JOB TITLE: ${job.job_title}
COMPANY: ${job.company_name}
JOB DESCRIPTION:
${(job.raw_text || '').slice(0, 3000)}

Reply with ONLY a JSON object, no other text, in this exact shape:
{"score": <number between 0 and 1>, "reason": "<one short sentence explaining the score>"}`
      }]
    });

    const text = msg.content?.[0]?.text || '';
    const parsed = JSON.parse(text.trim());
    if (typeof parsed.score !== 'number') return null;
    return { score: Math.max(0, Math.min(1, parsed.score)), reason: parsed.reason || '' };
  } catch (err) {
    console.error('[ai-match] scoring failed, will fall back to keyword score:', err.message);
    return null;
  }
}

module.exports = { isEnabled, scoreWithAI };
