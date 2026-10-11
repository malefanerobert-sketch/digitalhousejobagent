'use strict';
// Capture source text without AI rewriting, output budgets or arbitrary character truncation.
const SOURCE_PATTERN=String.raw`\b(?:adzuna|job\s*mail|pnet|career\s*junction|careers?\s*24|executive\s*placements|jobbi|jobrapido|jooble|indeed|linkedin|glassdoor|ziprecruiter|remote\s*ok|talent\.com)\b`;
const sourceRE=()=>new RegExp(SOURCE_PATTERN,'gi');
function privateText(value){
 return String(value||'').replace(/\\+(?=&(?:#\w+|\w+);)/g,'')
 .replace(/https?:\/\/[^\s<>]+|www\.[^\s<>]+/gi,'')
 .replace(/[\w.+-]+@(?:[\w.-]*\.)?(?:pnet|jobmail|careerjunction|careers24|adzuna|jobbi)\.[a-z.]+/gi,'')
 .replace(/\b(?:[a-z0-9-]+\.)*(?:adzuna|jobmail|pnet|careerjunction|careers24|jobbi|jobrapido|jooble|indeed|linkedin|glassdoor|ziprecruiter)\.[a-z.]+\b/gi,'')
 .replace(/#?J-\d+-Ljbffr/gi,'').replace(sourceRE(),'the application platform')
 .replace(/^.*(?:back to last search|create email alert|similar jobs|stats for this job|privacy notice|cookie use).*$/gmi,'')
 .replace(/[ \t]{2,}/g,' ').replace(/\n{3,}/g,'\n\n').trim();
}
function hasSections(text){return /(?:requirements|qualifications|minimum criteria|minimum education|experience required|key responsibilities|duties|closing date|competencies)/i.test(text);}
function limitedDescription(text){return !text || (text.length<800&&!hasSections(text));}
function browserEngine(){try{const e=require('playwright-extra');return e.chromium;}catch{return require('playwright').chromium;}}
const cache=new Map();
async function captureJobDetails(url,{browser=null,title='',employer=''}={}){
 const prior=cache.get(url);if(prior&&Date.now()-prior.at<15*60*1000)return prior.value;
 let owned=false,page=null;const seen=new Set();let best={description:null,status:'unavailable',employer:null};
 try{
  const parsed=new URL(url);if(!['http:','https:'].includes(parsed.protocol))return best;
  if(!browser){browser=await browserEngine().launch({headless:true,args:['--no-sandbox']});owned=true;}
  page=await browser.newPage();
  for(let hop=0;hop<3;hop++){
   if(seen.has(url))break;seen.add(url);
   const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:25000});
   if(response&&response.status()>=400)break;
   await page.waitForLoadState('networkidle',{timeout:4000}).catch(()=>{});
   // Only open read-more controls. Never click Apply/Submit or fill employer forms.
   for(const label of ['Show full description','Read full description','Show more','Read more']){
    const el=page.getByRole('button',{name:label,exact:true}).first();if(await el.isVisible().catch(()=>false))await el.click({timeout:1500}).catch(()=>{});
   }
   const extract=()=>{
    const postings=[];
    function walk(o){if(!o||typeof o!=='object')return;if(Array.isArray(o)){o.forEach(walk);return;}const types=Array.isArray(o['@type'])?o['@type']:[o['@type']];if(types.some(t=>/JobPosting/i.test(String(t))))postings.push(o);if(o['@graph'])walk(o['@graph']);}
    for(const script of document.querySelectorAll('script[type="application/ld+json"]'))try{walk(JSON.parse(script.textContent));}catch{}
    function plain(html){const doc=new DOMParser().parseFromString(String(html),'text/html');doc.querySelectorAll('script,style,nav,footer,header,form').forEach(n=>n.remove());doc.querySelectorAll('br').forEach(n=>n.replaceWith('\n'));doc.querySelectorAll('li').forEach(n=>n.prepend('• '));doc.querySelectorAll('p,div,li,ul,ol,h1,h2,h3,h4,tr').forEach(n=>n.append('\n'));return (doc.body.textContent||'').replace(/[ \t]{2,}/g,' ').replace(/ *\n */g,'\n').replace(/\n{3,}/g,'\n\n').trim();}
    const candidates=postings.filter(o=>o.description).map(o=>({text:plain(o.description),employer:o.hiringOrganization?.name||null,title:o.title||'',structured:true}));
    const selectors=['[itemprop="description"]','#job-description','#job_description','.job-description','.job_description','.jobDescription','.jobsearch-jobDescriptionText','.job-detail-description','.job-details-description','.vacancy-description','.job-ad-description','.job-ad-display','.jobad-content','.job-details-content','[class*="job-description"]','[class*="jobDescription"]','article.job','article[itemtype*="JobPosting"]'];
    for(const selector of selectors)for(const el of document.querySelectorAll(selector)){
     const copy=el.cloneNode(true);copy.querySelectorAll('script,style,nav,footer,header,form,[class*="similar"],[class*="related"],button').forEach(n=>n.remove());const text=plain(copy.innerHTML);if(text.length>100)candidates.push({text,employer:null,title:document.querySelector('h1')?.innerText||'',structured:false});
    }
    // Follow actual vacancy links only (not registration, generic careers or unrelated jobs).
    const links=[...document.querySelectorAll('a[href]')].map(a=>({url:a.href,label:(a.innerText||a.getAttribute('aria-label')||'').trim(),rel:a.getAttribute('rel')||''})).filter(a=>/^(?:apply for this job|apply now|apply|view original (?:job|advert)|view full (?:job|advert)|full job description|view job at employer)$/i.test(a.label)&&/^https?:/.test(a.url)&&!/(?:login|sign.?in|register|signup|javascript:)/i.test(a.url));
    // Some boards put the vacancy body after a description heading, outside a named container.
    for(const heading of document.querySelectorAll('h2,h3,h4')){
     if(!/^(?:job description|about (?:the role|this job)|role overview|vacancy details|job details)$/i.test((heading.textContent||'').trim()))continue;
     const holder=document.createElement('div');let sibling=heading.nextElementSibling;
     while(sibling&&!/^(?:similar|related|recommended|other) (?:jobs|vacancies)/i.test((sibling.textContent||'').trim())){holder.append(sibling.cloneNode(true));sibling=sibling.nextElementSibling;}
     const text=plain(holder.innerHTML);if(text.length>100)candidates.push({text,employer:null,title:document.querySelector('h1')?.innerText||'',structured:false});
    }
    return {candidates,links,pageTitle:document.querySelector('h1')?.innerText||document.title};
   };
   // Embedded recruitment portals often hold the real advert in a child frame.
   const results=await Promise.all(page.frames().map(frame=>frame.evaluate(extract).catch(()=>({candidates:[],links:[],pageTitle:''}))));
   const data={candidates:results.flatMap(x=>x.candidates),links:results.flatMap(x=>x.links),pageTitle:results[0]?.pageTitle||''};
   const words=s=>String(s||'').toLowerCase().replace(/[^a-z0-9 ]/g,' ').split(/\s+/).filter(w=>w.length>3);
   const expected=words(title);const titleOkay=c=>hop===0||!expected.length||expected.filter(w=>words(c.title||data.pageTitle).includes(w)).length>=Math.min(2,expected.length)||!!(employer&&c.employer&&c.employer.toLowerCase()===employer.toLowerCase());
   const ranked=data.candidates.filter(titleOkay).sort((a,b)=>b.text.length-a.text.length);
   const chosen=ranked[0];
   if(chosen){
    const text=privateText(chosen.text);
    if(text.length>(best.description||'').length || (hop>0&&!limitedDescription(text)))best={description:text,status:limitedDescription(text)?'limited':'captured',employer:chosen.employer||best.employer};
    if(best.status==='captured' && !data.links.some(l=>!seen.has(l.url)))break;
   }
   const next=data.links.find(l=>!seen.has(l.url));if(!next)break;url=next.url;
  }
 }catch(error){console.warn('[jobDetails] Full advert retrieval unavailable:',error.name||'Error');}
 finally{if(page)await page.close().catch(()=>{});if(owned&&browser)await browser.close().catch(()=>{});}
 if(cache.size>500)cache.clear();cache.set([...seen][0]||url,{at:Date.now(),value:best});return best;
}
async function refreshSavedDescriptions(sb,{browser=null,limit=8}={}){
 const cutoff=new Date(Date.now()-6*60*60*1000).toISOString();
 const {data,error}=await sb.from('job_matches').select('id,job_url,job_title,employer_name,job_description,job_description_status')
 .neq('job_description_status','captured').or('job_description_checked_at.is.null,job_description_checked_at.lt.'+cutoff)
 .order('job_description_checked_at',{ascending:true,nullsFirst:true}).order('discovered_at',{ascending:false}).limit(limit);
 if(error){console.warn('[jobDetails] Existing advert refresh unavailable');return;}
 for(const row of data||[]){
  const result=await captureJobDetails(row.job_url,{browser,title:row.job_title,employer:row.employer_name});
  const patch={job_description_checked_at:new Date().toISOString(),job_description_status:result.status};
  if(result.description && (result.status==='captured' || result.description.length>(row.job_description||'').length))patch.job_description=result.description;
  const {error:e}=await sb.from('job_matches').update(patch).eq('id',row.id);if(e)console.warn('[jobDetails] Could not save advert refresh');
 }
}
module.exports={captureJobDetails,refreshSavedDescriptions,privateText,limitedDescription};
