const assert=require('node:assert/strict');
const {GroqKeyPool,retryDelayMs,SLOT_COUNT}=require('./groqKeyPool');
const ok=text=>new Response(JSON.stringify({choices:[{message:{content:text||'OK'}}]}));
const fail=(status,headers={},message='limit')=>new Response(JSON.stringify({error:{message}}),{status,headers});
function setup(keys,responses,options={}){
 let now=1000;const calls=[],waits=[];
 const pool=new GroqKeyPool({now:()=>now,sleep:async ms=>{waits.push(ms);now+=ms;},logger:{warn(){}},...options,fetchImpl:async(u,o)=>{calls.push({key:o.headers.Authorization,body:JSON.parse(o.body)});const r=responses.shift();if(r instanceof Error)throw r;return r||ok();}});
 pool.configure(keys,null,60);return {pool,calls,waits};
}
(async()=>{
 assert.equal(SLOT_COUNT,20);
 let twenty=Array.from({length:20},(_,i)=>'fake-slot-'+(i+1));
 let expanded=setup(twenty,[]);for(let i=0;i<21;i++)await expanded.pool.complete('shared-model',[],20);
 assert.deepEqual(expanded.calls.map(c=>c.key),[...twenty,twenty[0]].map(k=>'Bearer '+k));
 assert(expanded.calls.every(c=>c.body.model==='shared-model'));console.log('PASS all twenty slots rotate and K20 wraps to K1');
 expanded=setup(twenty,[fail(429),ok()]);expanded.pool.next=9;await expanded.pool.complete('shared-model',[],20);
 assert.deepEqual(expanded.calls.map(c=>c.key),['Bearer fake-slot-10','Bearer fake-slot-11']);console.log('PASS rate limit on K10 switches to K11');
 expanded=setup([...Array(19).fill(null),'fake-slot-20'],[]);await expanded.pool.complete('shared-model',[],20);
 assert.equal(expanded.calls[0].key,'Bearer fake-slot-20');console.log('PASS K20 works when earlier slots are empty');
 expanded=setup(twenty.slice(0,10),[]);assert.equal(expanded.pool.slots.length,20);assert.deepEqual(expanded.pool.slots.slice(10),Array(10).fill(null));console.log('PASS legacy ten-slot settings safely pad to twenty');
 let t=setup(['fake-a','fake-b'],[fail(429,{'retry-after':'2'}),ok()]);assert.equal(await t.pool.complete('llama-3.3-70b-versatile',[{role:'user',content:'test'}],20),'OK');assert.deepEqual(t.calls.map(c=>c.key),['Bearer fake-a','Bearer fake-b']);assert.deepEqual(t.calls[0].body,t.calls[1].body);console.log('PASS rate-limit failover keeps prompt/model unchanged');
 t=setup(['fake-a','fake-b'],[ok(),ok(),ok()]);for(let i=0;i<3;i++)await t.pool.complete('same-model',[],20);assert.deepEqual(t.calls.map(c=>c.key),['Bearer fake-a','Bearer fake-b','Bearer fake-a']);console.log('PASS round-robin');
 t=setup(['fake-a','fake-b'],[fail(401),ok()]);await t.pool.complete('m',[],20);assert(t.pool.health.get('fake-a').invalid);console.log('PASS invalid key failover');
 t=setup(['fake-a','fake-a','fake-b'],[fail(429),ok()]);await t.pool.complete('m',[],20);assert.equal(t.calls[1].key,'Bearer fake-b');console.log('PASS duplicate key cooldown');
 t=setup(['fake-a'],[fail(429,{'retry-after':'1'}),ok()]);await t.pool.complete('m',[],20);assert.deepEqual(t.waits,[1250]);console.log('PASS automatic cooldown wait and retry');
 t=setup(['fake-a'],[fail(429,{'retry-after':'3600'})]);await assert.rejects(t.pool.complete('m',[],20),/cooling down/);assert.equal(t.waits.length,0);console.log('PASS long cooldown does not stall run');
 t=setup(['fake-a','fake-b'],[fail(400),ok()]);await assert.rejects(t.pool.complete('m',[],20),/400/);assert.equal(t.calls.length,1);console.log('PASS bad requests are not rotated');
 t=setup(['fake-a','fake-b'],[fail(503),ok()]);await t.pool.complete('m',[],20);assert.equal(t.calls.length,2);console.log('PASS server error failover');
 t=setup(['fake-a','fake-b'],[new Error('offline'),ok()]);await t.pool.complete('m',[],20);assert.equal(t.calls.length,2);console.log('PASS network error failover');
 t=setup([],[]);t.pool.configure([], 'legacy-fake', 60);await t.pool.complete('m',[],20);assert.equal(t.calls[0].key,'Bearer legacy-fake');assert.equal(t.pool.slots.length,20);console.log('PASS legacy key and exactly twenty slots');
 t=setup(['fake-a'],[]);t.pool.health.get('fake-a').until=2000;t.pool.configure(['fake-a'],null,60);assert.equal(t.pool.health.get('fake-a').until,2000);t.pool.configure(['new-fake'],null,60);assert.equal(t.pool.health.get('new-fake').until,0);console.log('PASS unchanged key health survives settings reload; replacement resets');
 assert.equal(retryDelayMs(new Headers({'retry-after':'2','x-ratelimit-remaining-tokens':'0','x-ratelimit-reset-tokens':'2m'}),'Try again in 1m3s',60),120250);console.log('PASS provider cooldown timing');
 // Test completeWithAI and scoreWithAI through the patched real helper.
 const realFetch=global.fetch;let sharedCalls=[];
 global.fetch=async(u,o)=>{sharedCalls.push(o);return ok(sharedCalls.length===1?'answer':'{"score":0.8,"reason":"fit"}');};
 const ai=require('./aiMatch');const settings={ai_provider:'groq',ai_api_key:null,ai_api_keys:[...Array(19).fill(null),'shared-fake'],ai_model:'chosen-model',agent_enabled:true};
 const sb={from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:settings,error:null})})})})};
 await ai.loadSettings(sb);assert(ai.isEnabled());assert.equal(await ai.completeWithAI('test'), 'answer');assert.equal(JSON.parse(sharedCalls[0].body).model,'chosen-model');assert.equal((await ai.scoreWithAI('resume',{job_title:'job',company_name:'co'})).score,.8);console.log('PASS aiMatch uses slot pool for completion and scoring');
 await ai.completeWithAI('override',{provider:'groq',apiKey:'personal-fake',model:'override-model'});assert.equal(sharedCalls.at(-1).headers.Authorization,'Bearer personal-fake');assert.equal(JSON.parse(sharedCalls.at(-1).body).model,'override-model');global.fetch=realFetch;console.log('PASS per-user override stays separate');
})().catch(e=>{console.error(e);process.exitCode=1;});
