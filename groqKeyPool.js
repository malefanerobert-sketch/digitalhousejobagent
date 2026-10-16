// Shared company Groq pool. Cooldowns are process-local, never a way to bypass organization quotas.
// Uses built-in fetch (Node 18+); no extra dependencies.
const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';
const SLOT_COUNT = 100;
const clean = v => typeof v === 'string' ? v.trim().replace(/^bearer\s+/i, '').replace(/^["']|["']$/g, '').trim() : '';
function durationMs(value) {
  const s = String(value || '').trim();
  if (/^\d+(?:\.\d+)?$/.test(s)) return Number(s) * 1000;
  let total = 0;
  for (const m of s.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)/gi)) total += Number(m[1]) * ({ms:1,s:1000,m:60000,h:3600000,d:86400000}[m[2].toLowerCase()]);
  return total;
}
function retryDelayMs(headers, message, fallbackSeconds) {
  const delays = [];
  const ra = headers?.get('retry-after');
  if (ra) delays.push(/^\d+(?:\.\d+)?$/.test(ra.trim()) ? Number(ra)*1000 : Date.parse(ra)-Date.now());
  for (const kind of ['requests', 'tokens']) {
    const remaining = headers?.get('x-ratelimit-remaining-' + kind);
    if (remaining != null && Number(remaining) <= 0) delays.push(durationMs(headers.get('x-ratelimit-reset-' + kind)));
  }
  const hint = String(message || '').match(/(?:try again|retry)\s+in\s+((?:\d+(?:\.\d+)?\s*(?:ms|s|m|h|d)\s*)+)/i);
  if (hint) delays.push(durationMs(hint[1]));
  const valid = delays.filter(n => Number.isFinite(n) && n > 0);
  return (valid.length ? Math.max(...valid) : fallbackSeconds*1000) + 250;
}
function groqRequestBody(model, messages, maxTokens) {
  const body = { model, messages, max_completion_tokens: maxTokens };
  if (/^openai\/gpt-oss-(20b|120b)$/.test(model)) {
    // The completion budget includes reasoning; don't spend scoring's whole
    // 200-token budget before returning the actual JSON answer.
    body.max_completion_tokens = Math.max(2048, maxTokens);
    body.reasoning_effort = 'low';
    body.include_reasoning = false;
  }
  return body;
}
class GroqKeyPool {
  constructor({fetchImpl = (...args)=>fetch(...args), now = ()=>Date.now(), sleep = ms=>new Promise(r=>setTimeout(r,ms)), logger = console, maxWaitMs = 90000} = {}) {
    this.fetch = fetchImpl; this.now = now; this.sleep = sleep; this.logger = logger; this.maxWaitMs = maxWaitMs;
    this.slots = Array(SLOT_COUNT).fill(null); this.health = new Map(); this.next = 0; this.cooldownSeconds = 60;
  }
  configure(keys, legacyKey, cooldownSeconds) {
    const slots = Array.from({length:SLOT_COUNT}, (_,i)=>clean(Array.isArray(keys)?keys[i]:null) || null);
    if (!slots.some(Boolean)) slots[0] = clean(legacyKey) || null;
    this.slots = slots;
    this.cooldownSeconds = Math.max(10, Math.min(600, Number(cooldownSeconds)||60));
    const present = new Set(slots.filter(Boolean));
    for (const key of this.health.keys()) if (!present.has(key)) this.health.delete(key);
    for (const key of present) if (!this.health.has(key)) this.health.set(key,{until:0,invalid:false});
  }
  hasKeys() { return this.slots.some(Boolean); }
  async complete(model, messages, maxTokens) {
    const deadline = this.now()+this.maxWaitMs;
    let transientFailures = 0;
    while (true) {
      const usable = this.slots.map((key,i)=>({key,i,health:this.health.get(key)})).filter(x=>x.key && !x.health.invalid);
      if (!usable.length) throw new Error('No valid shared Groq key; replace keys in Admin');
      const ready = usable.filter(x=>x.health.until <= this.now()).sort((a,b)=>((a.i-this.next+SLOT_COUNT)%SLOT_COUNT)-((b.i-this.next+SLOT_COUNT)%SLOT_COUNT));
      if (!ready.length) {
        const wait = Math.max(1, Math.min(...usable.map(x=>x.health.until))-this.now());
        if (wait > deadline-this.now()) throw new Error('All shared Groq keys are cooling down; this task uses its existing fallback and keys will be retried on a later call');
        this.logger.warn(`[groq-pool] all keys cooling down; retry in ${Math.ceil(wait/1000)}s`);
        await this.sleep(wait); continue;
      }
      const {key,i,health} = ready[0]; this.next=(i+1)%SLOT_COUNT;
      let res;
      try {
        res=await this.fetch(ENDPOINT,{
          method:'POST', signal:AbortSignal.timeout(45000),
          headers:{'Content-Type':'application/json',Authorization:`Bearer ${key}`},
          body:JSON.stringify(groqRequestBody(model,messages,maxTokens))
        });
      } catch (_) {
        health.until=this.now()+this.cooldownSeconds*1000;
        this.logger.warn(`[groq-pool] K${i+1} network failure; switching slots`);
        if (++transientFailures >= Math.max(3,new Set(usable.map(x=>x.key)).size)) throw new Error('Shared Groq keys temporarily unreachable');
        continue;
      }
      if (res.ok) {
        const data=await res.json();
        if (data.error) throw new Error('Groq returned an error in a successful response');
        const content=data.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('Groq returned no completion text');
        return content;
      }
      const data=await res.json().catch(()=>({}));
      const detail=data.error||{};
      if (res.status===429 || /rate[_ -]?limit|quota[_ -]?(?:exceeded|exhausted)/i.test(detail.code||detail.type||'')) {
        const ms=retryDelayMs(res.headers,detail.message,this.cooldownSeconds);
        health.until=this.now()+ms;
        this.logger.warn(`[groq-pool] K${i+1} rate limited; ${Math.ceil(ms/1000)}s cooldown; switching slots`);
        continue;
      }
      if (res.status===401) {
        health.invalid=true;
        this.logger.warn(`[groq-pool] K${i+1} invalid; switching slots`); continue;
      }
      if (res.status===404 || res.status===400) {
        const code=String(detail.code||'').slice(0,80);
        if (/model/i.test(code) || /model/i.test(String(detail.message||''))) throw new Error(`Groq model ${model} unavailable (${res.status}${code ? '; '+code : ''}); refresh models in Admin and save an active model`);
      }
      if (res.status>=500) {
        health.until=this.now()+retryDelayMs(res.headers,detail.message,this.cooldownSeconds);
        this.logger.warn(`[groq-pool] K${i+1} HTTP ${res.status}; switching slots`);
        if (++transientFailures >= Math.max(3,new Set(usable.map(x=>x.key)).size)) throw new Error('Shared Groq service temporarily unavailable');
        continue;
      }
      // Bad prompts, wrong models and permission errors are not fixed by swapping keys.
      throw new Error(`Groq API error (${res.status}); check the selected model and request`);
    }
  }
}
module.exports={GroqKeyPool,retryDelayMs,SLOT_COUNT,groqRequestBody};
