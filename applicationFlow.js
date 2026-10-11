// Conservative application-navigation, usable-control and receipt helpers.
// Never submits, changes eligibility or retries an uncertain submission by itself.
function isAggregatorUrl(url) {
  try { return /(^|\.)adzuna\.[a-z.]+$/i.test(new URL(url).hostname); } catch { return false; }
}
function findConfirmationText(bodyText) {
  const positive = [
    /\byour application\s+(?:(?:has been|was|is)\s+)?(?:successfully\s+)?(?:submitted|received)\b/i,
    /\b(?:we have|we've|we)\s+(?:successfully\s+)?received\s+your application\b/i,
    /\byou (?:have |have been )?successfully applied\b/i,
    /\b(?:thank you|thanks) for (?:applying|submitting your application)\b/i,
    /\bapplication (?:successfully submitted|submission successful)\b/i
  ];
  const instruction = /\b(?:must|should|required|please|before|prior to|after|once|if|when|until|click|need to|will be|can be|may be|how to|not (?:been )?(?:submitted|received))\b/i;
  const lines = String(bodyText || '').split(/\n+|(?<=[.!?])\s+/).map(s => s.replace(/\s+/g,' ').trim()).filter(Boolean);
  return lines.find(s => s.length<=600 && !instruction.test(s) && positive.some(p=>p.test(s))) || null;
}
function actionableError(error) {
  const m=String(error?.message || error || 'Unknown application error');
  if (/not visible|not enabled|not editable|element.*detached|elementHandle\.(?:click|fill)|locator\.(?:click|fill)|intercepts pointer/i.test(m)) return 'Could not use a visible, editable application control. This is a form-layout or overlay problem, not proof of a broken job URL.';
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN|ERR_CONNECTION|net::/i.test(m)) return 'Could not reach the application site. Check the original job URL or try again later.';
  if (/Timeout|timed out|ERR_TIMED_OUT/i.test(m)) return 'The application page or form control timed out. Submission was not confirmed.';
  return m.slice(0,600);
}
async function usable(el,{file=false}={}) {
  if (!el || !await el.isEnabled().catch(()=>false)) return false;
  if (await el.isVisible().catch(()=>false)) return true;
  if (!file) return false;
  // Real upload controls are often hidden behind a visible dropzone. An inactive
  // hidden form is not a usable upload surface.
  return await el.evaluate(e=>{
    if(e.type!=='file'||!e.isConnected||e.disabled)return false;
    const form=e.closest('form');
    return !!form && !!form.getClientRects().length && getComputedStyle(form).visibility!=='hidden';
  }).catch(()=>false);
}
async function firstUsableAcrossFrames(page,selector) {
  const candidates=[];
  for(const frame of page.frames()) {
    const els=await frame.$$(selector).catch(()=>[]);
    for(const el of els) {
      const file=(await el.getAttribute('type').catch(()=>''))==='file';
      if(!await usable(el,{file}))continue;
      const score=await el.evaluate(e=>{const f=e.closest('form');if(!f)return 0;return (f.querySelector('input[type="file"]')?5:0)+(f.querySelector('input[autocomplete="name"],input[autocomplete="given-name"],input[name*="name" i]:not([name*="user" i])')?3:0)+(f.querySelector('input[type="email"]')?2:0)-(f.querySelector('input[type="password"]')?15:0);}).catch(()=>0);
      candidates.push({el,score});
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  return candidates[0]?.el||null;
}

async function controlText(el) {
  return await el.evaluate(e=>(e.innerText||e.value||e.getAttribute('aria-label')||'').replace(/\s+/g,' ').trim()).catch(()=>'');
}
async function findApplyEntryPoint(page) {
  for(const frame of page.frames()) {
    const els=await frame.$$('a[href], button, [role="button"], input[type="button"]').catch(()=>[]);
    const candidates=[];
    for(const el of els) {
      if(!await usable(el))continue;
      const label=await controlText(el);
      if(!/^(?:apply(?: now| for (?:this |the )?(?:job|role|position))?|start (?:your )?application|apply on (?:the )?(?:company|employer)(?: site| website)?)$/i.test(label))continue;
      const eligible=await el.evaluate(e=>{
        const form=e.closest('form');
        // This helper only enters forms. It must never click an application's
        // final submission button while trying to navigate.
        return !form || !form.querySelector('input[type="file"],input[autocomplete="given-name"],input[autocomplete="name"],input[name*="name" i],textarea');
      }).catch(()=>false);
      if(eligible)candidates.push(el);
    }
    if(candidates.length)return candidates[0];
  }
  return null;
}
async function clickAndFollow(page,el) {
  const popup=page.waitForEvent('popup',{timeout:1500}).catch(()=>null);
  await el.scrollIntoViewIfNeeded();
  await el.click({timeout:10000});
  const newPage=await popup;
  const target=newPage||page;
  await target.waitForLoadState('domcontentloaded',{timeout:15000}).catch(()=>{});
  await target.waitForTimeout(350);
  return target;
}
async function reachApplicationPage(page,{maxHops=5}={}) {
  const visited=new Set();let target=page;
  for(let hop=0;hop<maxHops;hop++) {
    if(!isAggregatorUrl(target.url()))return {ok:true,page:target};
    if(visited.has(target.url()))return {ok:false,page:target,reason:'The job-board Apply link looped back to the same advert; no employer application form was reached.'};
    visited.add(target.url());
    const entry=await findApplyEntryPoint(target);
    if(!entry)return {ok:false,page:target,reason:'This Adzuna advert has no usable Apply link to the employer. The agent will not submit a newsletter or job-alert form on the listing page.'};
    target=await clickAndFollow(target,entry);
  }
  return {ok:false,page:target,reason:'Could not reach the employer application page within the navigation limit.'};
}
async function applicationFields(page) {
  const result=[];
  for(const frame of page.frames()) {
    const rows=await frame.evaluate(start=>{
      const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
      const forms=Array.from(document.forms).filter(visible).map(f=>{
        const text=(f.innerText||'').toLowerCase();
        const file=f.querySelector('input[type="file"]');
        const name=f.querySelector('input[autocomplete="name"],input[autocomplete="given-name"],input[name*="name" i]:not([name*="user" i])');
        const email=f.querySelector('input[type="email"]');
        return {f,score:(file?5:0)+(name?3:0)+(email?2:0)+(/application|candidate|resume|résumé/.test(text)?2:0)-(f.querySelector('input[type="password"]')?15:0)};
      }).sort((a,b)=>b.score-a.score);
      const root=forms[0]?.score>=5?forms[0].f:document;
      if(forms.length&&root===document)return [];
      return Array.from(root.querySelectorAll('input,select,textarea')).filter(e=>{
        if(e.disabled||['hidden','submit','button','image','reset','password'].includes(e.type))return false;
        return visible(e)||(e.type==='file'&&e.closest('form')&&visible(e.closest('form')));
      }).map((e,i)=>{
        const idx=start+i;e.setAttribute('data-agent-idx',String(idx));
        const label=e.id?document.querySelector('label[for="'+CSS.escape(e.id)+'"]'):null;
        return {idx,tag:e.tagName.toLowerCase(),type:e.type||null,name:e.name||null,id:e.id||null,placeholder:e.placeholder||null,ariaLabel:e.getAttribute('aria-label'),label:(label?.textContent||e.closest('label')?.textContent||'').trim()||null,required:!!(e.required||e.getAttribute('aria-required')==='true'),options:e.tagName==='SELECT'?Array.from(e.options).slice(0,60).map(o=>o.textContent.trim()||o.value):undefined};
      });
    },result.length).catch(()=>[]);
    result.push(...rows);
  }
  return result;
}
async function requiredErrors(page) {
  const missing=[];
  for(const frame of page.frames()) {
    const errors=await frame.evaluate(()=>{
      const visible=e=>!!e.getClientRects().length&&getComputedStyle(e).visibility!=='hidden';
      const ranked=Array.from(document.forms).filter(visible).map(f=>({f,score:(f.querySelector('input[type="file"]')?5:0)+(f.querySelector('input[autocomplete="name"],input[autocomplete="given-name"],input[name*="name" i]:not([name*="user" i])')?3:0)+(f.querySelector('input[type="email"]')?2:0)-(f.querySelector('input[type="password"]')?15:0)})).sort((a,b)=>b.score-a.score);
      const root=ranked[0]?.score>=5?ranked[0].f:document;
      return Array.from(root.querySelectorAll('input,select,textarea')).filter(e=>{
        if(e.disabled||['hidden','submit','button','reset','password'].includes(e.type))return false;
        if(!visible(e)&&!(e.type==='file'&&e.closest('form')&&visible(e.closest('form'))))return false;
        const required=e.required||e.getAttribute('aria-required')==='true';
        if(!required)return false;
        if(e.type==='radio')return !Array.from(document.querySelectorAll('input[type="radio"]')).some(x=>x.name===e.name&&x.checked);
        if(e.type==='checkbox')return !e.checked;
        if(e.type==='file')return !e.files?.length;
        return !String(e.value||'').trim() || (e.willValidate&&e.validity&&!e.validity.valid);
      }).map(e=>{
        const label=e.id?document.querySelector('label[for="'+CSS.escape(e.id)+'"]'):null;
        return (label?.textContent||e.closest('label')?.textContent||e.getAttribute('aria-label')||e.placeholder||e.name||'Required application field').replace(/\s+/g,' ').trim().slice(0,180);
      });
    }).catch(()=>[]);
    missing.push(...errors);
  }
  return [...new Set(missing)];
}
async function findStepButton(page) {
  const next=/^(?:next(?: step)?|continue(?: application)?|proceed|save and continue|review(?: (?:your )?application)?)$/i;
  const final=/^(?:submit(?: (?:your )?application)?|send application|apply(?: now)?|finish application|complete application|confirm (?:and submit|application))$/i;
  let finalCandidate=null;
  for(const frame of page.frames()) {
    const controls=await frame.$$('button,input[type="submit"],input[type="button"],a,[role="button"]').catch(()=>[]);
    for(const el of controls) {
      if(!await usable(el))continue;
      const text=await controlText(el);
      if(next.test(text))return {el,isFinal:false};
      if(!final.test(text))continue;
      const inApplication=await el.evaluate(e=>{
        const form=e.closest('form');
        if(!form){const label=(e.innerText||e.value||e.getAttribute('aria-label')||'').trim();return e.tagName!=='A'&&/^(?:submit(?: your)? application|send application|finish application|complete application)$/i.test(label)&&!!document.querySelector('[data-agent-idx]');}
        return !form.querySelector('input[type="password"],input[type="search"]')&&!!form.querySelector('input[type="file"],input[autocomplete="name"],input[autocomplete="given-name"],input[name*="name" i]:not([name*="user" i]),textarea');
      }).catch(()=>false);
      if(inApplication&&!finalCandidate)finalCandidate={el,isFinal:true};
    }
  }
  return finalCandidate;
}
async function snapshotReceiptPage(page) {
  let text='';
  for(const frame of page.frames())text+='\n'+await frame.evaluate(()=>(document.body?.innerText||'').slice(0,20000)).catch(()=>'');
  return {url:page.url(),text};
}
async function waitForReceipt(page,before,{timeoutMs=15000,pollMs=300}={}) {
  const deadline=Date.now()+timeoutMs;
  while(Date.now()<deadline) {
    const after=await snapshotReceiptPage(page);
    const receipt=findConfirmationText(after.text);
    if(!isAggregatorUrl(after.url)&&receipt&&!String(before?.text||'').includes(receipt))return {ok:true,receipt,url:after.url,text:after.text};
    await page.waitForTimeout(pollMs);
  }
  const after=await snapshotReceiptPage(page);
  return {ok:false,url:after.url,text:after.text,reason:'No new, explicit submission receipt appeared on the application site. This is not marked Applied and will not be automatically resubmitted.'};
}
async function loginBarrier(page) {
  const password=await firstUsableAcrossFrames(page,'input[type="password"]');
  const otp=await firstUsableAcrossFrames(page,'input[autocomplete="one-time-code"]');
  return password||otp ? 'This employer requires an account login or verification code. A human must complete that step; the agent will not invent credentials.' : null;
}
module.exports={isAggregatorUrl,findConfirmationText,actionableError,usable,firstUsableAcrossFrames,findApplyEntryPoint,clickAndFollow,reachApplicationPage,applicationFields,requiredErrors,findStepButton,snapshotReceiptPage,waitForReceipt,loginBarrier};
