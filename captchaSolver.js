/** 2Captcha adapter. Detection, provider errors and delivery are recorded separately.
 * A delivered CAPTCHA token is NOT an employer application receipt.
 * Never logs API keys/tokens and never submits an application from a callback.
 */
let Solver=null;
try { Solver=require('2captcha').Solver; } catch (_) {}

function providerFailure(err){
  const text=String(err?.code||err?.message||err||'');
  const code=text.match(/\b(?:ERROR_[A-Z0-9_]+|CAPCHA_NOT_READY|CAPTCHA_NOT_READY)\b/)?.[0]||'SOLVER_REQUEST_FAILED';
  const reasons={ERROR_ZERO_BALANCE:'2Captcha has no available balance.',ERROR_WRONG_USER_KEY:'2Captcha API key is invalid.',ERROR_KEY_DOES_NOT_EXIST:'2Captcha API key is invalid.',ERROR_NO_SLOT_AVAILABLE:'2Captcha has no solver capacity available.',ERROR_CAPTCHA_UNSOLVABLE:'2Captcha could not solve this challenge.',ERROR_RECAPTCHA_INVALID_SITEKEY:'The page CAPTCHA site key is invalid.',ERROR_BAD_PARAMETERS:'The CAPTCHA request parameters were rejected.'};
  return {code,reason:(reasons[code]||'2Captcha request failed.')+' ['+code+']'};
}
function createCaptchaService({client=null,apiKeyPresent=false,packageAvailable=true,logger=console}={}){
  const ENABLED=!!client;
  async function detectCaptcha(page){
    let fallback=null;
    for(const frame of page.frames()){
      try {
        const found=await frame.evaluate(()=>{
          const visible=el=>!!(el&&el.getClientRects().length&&getComputedStyle(el).visibility!=='hidden'&&getComputedStyle(el).display!=='none');
          const config=(el,type)=>({type,sitekey:el.getAttribute('data-sitekey'),invisible:el.getAttribute('data-size')==='invisible',callbackName:el.getAttribute('data-callback')||null,action:el.getAttribute('data-action')||null,enterprise:false});
          // Specific providers MUST be checked before generic data-sitekey.
          const ts=document.querySelector('.cf-turnstile[data-sitekey],[data-cf-turnstile-widget-id][data-sitekey]');
          if(ts)return {...config(ts,'turnstile'),satisfied:!!document.querySelector('[name="cf-turnstile-response"]')?.value};
          const hc=document.querySelector('.h-captcha[data-sitekey],[data-hcaptcha-widget-id][data-sitekey]');
          if(hc)return {...config(hc,'hcaptcha'),satisfied:!!document.querySelector('[name="h-captcha-response"]')?.value};
          const rc=document.querySelector('.g-recaptcha[data-sitekey]');
          if(rc)return {...config(rc,'recaptcha_v2'),satisfied:!!document.querySelector('[name="g-recaptcha-response"]')?.value,enterprise:!!document.querySelector('script[src*="recaptcha/enterprise.js"]')};
          for(const el of document.querySelectorAll('iframe[src]')){
            const src=el.getAttribute('src')||'';
            if(/(?:google\.com|recaptcha\.net)\/recaptcha\/(?:api2|enterprise)\/anchor/.test(src)){
              const u=new URL(src,location.href),key=u.searchParams.get('k');
              if(key)return {type:'recaptcha_v2',sitekey:key,invisible:u.searchParams.get('size')==='invisible',enterprise:src.includes('/enterprise/'),callbackName:null,satisfied:!!document.querySelector('[name="g-recaptcha-response"]')?.value};
            }
          }
          const script=document.querySelector('script[src*="recaptcha/api.js"],script[src*="recaptcha/enterprise.js"]');
          if(script){const key=new URL(script.src,location.href).searchParams.get('render');if(key&&key!=='explicit')return {type:'recaptcha_v3',sitekey:key,action:null,minScore:0.4,enterprise:script.src.includes('enterprise.js'),callbackName:null,satisfied:!!document.querySelector('[name="g-recaptcha-response"]')?.value};}
          // Unknown challenges need human review; generic hidden CAPTCHA classes aren't proof of a block.
          const challenge=[...document.querySelectorAll('iframe[src*="recaptcha"][src*="bframe"],iframe[src*="hcaptcha"],iframe[src*="challenges.cloudflare.com"],.g-recaptcha,.h-captcha,.cf-turnstile')].find(visible);
          return challenge?{type:'unknown',sitekey:null}:null;
        });
        if(found){const info={...found,pageUrl:page.url(),frameUrl:frame.url(),frame};if(found.type!=='unknown')return info;fallback=info;}
      }catch(_){/* detached/unreadable frame; don't crash the run */}
    }
    return fallback;
  }
  async function solveDetailed(info){
    if(!ENABLED)return {ok:false,status:apiKeyPresent?(packageAvailable?'solver_unavailable':'package_missing'):'key_missing',reason:apiKeyPresent?(packageAvailable?'2Captcha client could not be initialized.':'2Captcha package is missing from the worker.'):'CAPTCHA_API_KEY is not configured in the worker.'};
    if(!info.sitekey||info.type==='unknown')return {ok:false,status:'unsupported_challenge',reason:'A CAPTCHA is visible, but its provider/site key could not be identified. Manual review is required.'};
    // v3 action is site-specific; guessing "submit" can produce a rejected token.
    if(info.type==='recaptcha_v3'&&!info.action)return {ok:false,status:'v3_action_unknown',reason:'reCAPTCHA v3 requires the employer’s exact action; this page did not expose it. Manual review is required.'};
    try {
      let answer;
      if(info.type==='recaptcha_v2')answer=await client.recaptcha(info.sitekey,info.pageUrl,{...(info.invisible?{invisible:1}:{}),...(info.enterprise?{enterprise:1}:{})});
      else if(info.type==='recaptcha_v3')answer=await client.recaptcha(info.sitekey,info.pageUrl,{version:'v3',action:info.action,min_score:info.minScore||0.4,...(info.enterprise?{enterprise:1}:{})});
      else if(info.type==='hcaptcha')answer=await client.hcaptcha(info.sitekey,info.pageUrl);
      else if(info.type==='turnstile'){
        const fn=client.turnstile||client.cloudflareTurnstile;if(!fn)return {ok:false,status:'unsupported_client',reason:'The installed 2Captcha client does not support Turnstile.'};
        answer=await fn.call(client,info.sitekey,info.pageUrl,info.action?{action:info.action}:{});
      }else return {ok:false,status:'unsupported_challenge',reason:'Unsupported CAPTCHA provider.'};
      const token=answer?.data;
      if(!token||typeof token!=='string')return {ok:false,status:'empty_token',reason:'2Captcha returned no usable solution token.'};
      return {ok:true,token};
    }catch(err){const fail=providerFailure(err);return {ok:false,status:fail.code,reason:fail.reason};}
  }
  async function injectDetailed(page,info,token){
    const frames=page.frames();
    const target=info.frame&&frames.includes(info.frame)?info.frame:frames.find(f=>f.url()===info.frameUrl);
    if(!target)return {ok:false,status:'frame_detached',reason:'The CAPTCHA frame changed before the solution could be delivered.'};
    try {
      const result=await target.evaluate(({type,token,callbackName})=>{
        const selectors={recaptcha_v2:'[name="g-recaptcha-response"]',recaptcha_v3:'[name="g-recaptcha-response"]',hcaptcha:'[name="h-captcha-response"],[name="g-recaptcha-response"]',turnstile:'[name="cf-turnstile-response"]'};
        let written=false,callback=false;
        const controls=[...document.querySelectorAll(selectors[type]||'')];
        // Do not create a token field in document.body: that isn't the employer's form.
        for(const el of controls){el.value=token;el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));written=true;}
        const invoke=fn=>{if(typeof fn!=='function')return;try{fn(token);callback=true;}catch(_){}};
        if(callbackName){const fn=callbackName.split('.').reduce((o,k)=>o?.[k],window);invoke(fn);}
        // Bounded traversal, with a visited set: grecaptcha client configs can be cyclic.
        if(!callback&&type.startsWith('recaptcha')){
          const clients=Object.values(window.___grecaptcha_cfg?.clients||{});
          if(clients.length===1){const seen=new WeakSet();let visits=0;const walk=(o,depth)=>{if(!o||typeof o!=='object'||seen.has(o)||depth>12||++visits>1000)return;seen.add(o);try{if(typeof o.callback==='function')invoke(o.callback);for(const v of Object.values(o))walk(v,depth+1);}catch(_){}};walk(clients[0],0);}
        }
        return {written,callback};
      },{type:info.type,token,callbackName:info.callbackName});
      if(!result.written&&!result.callback)return {ok:false,status:'token_not_delivered',reason:'2Captcha returned a token, but the employer’s response field/callback could not be reached. No successful solve is claimed.'};
      return {ok:true,status:'token_delivered',...result};
    }catch(_){return {ok:false,status:'injection_failed',reason:'The CAPTCHA solution could not be delivered to the employer’s form.'};}
  }
  async function solveCaptchaOnPageDetailed(page){
    const info=await detectCaptcha(page);
    if(!info)return {ok:true,present:false,status:'no_challenge'};
    if(info.satisfied)return {ok:true,present:true,status:'response_already_present',type:info.type};
    const solved=await solveDetailed(info);
    if(!solved.ok){logger.warn(`[captcha] ${info.type}: ${solved.reason}`);return {...solved,present:true,type:info.type};}
    const delivered=await injectDetailed(page,info,solved.token);
    logger[delivered.ok?'log':'warn'](`[captcha] ${info.type}: ${delivered.ok?'token delivered; employer acceptance still required':delivered.reason}`);
    return {...delivered,present:true,type:info.type};
  }
  return {ENABLED,detectCaptcha,detectRecaptcha:detectCaptcha,solveCaptchaOnPageDetailed,
    solveCaptchaOnPage:async p=>{const r=await solveCaptchaOnPageDetailed(p);return !!(r.ok&&r.present);},
    solveCaptcha:async i=>{const r=await solveDetailed(i);return r.ok?r.token:null;},
    solveRecaptcha:async i=>{const r=await solveDetailed(i);return r.ok?r.token:null;},
    injectToken:async(p,i,t)=>(await injectDetailed(p,i,t)).ok,solveDetailed,injectDetailed};
}
const apiKey=process.env.CAPTCHA_API_KEY;
let client=null;
try{if(apiKey&&Solver)client=new Solver(apiKey);}catch(_){console.warn('[captcha] 2Captcha client initialization failed');}
const service=createCaptchaService({client,apiKeyPresent:!!apiKey,packageAvailable:!!Solver});
if(client){client.balance().then(b=>console.log(`[captcha] enabled, balance $${Number(b).toFixed(3)}`)).catch(e=>console.warn('[captcha] balance check: '+providerFailure(e).reason));}
else console.warn('[captcha] solver disabled: '+(!apiKey?'CAPTCHA_API_KEY not configured':'2Captcha client unavailable'));
module.exports={...service,createCaptchaService,providerFailure};
