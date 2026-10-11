const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('/data/application-tests/node_modules/playwright');
const fit=require('./jobFit');
(async()=>{
 for(const pref of ['Gauteng','GAuteng za','Gauteng south africa','Gauteng, ZA']){
  for(const loc of ['Gauteng','GAuteng za','Gauteng south africa','Gauteng, ZA'])assert(fit.locationInScope(loc,[pref]));
  assert(fit.locationInScope('Pretoria',[pref]));assert(!fit.locationInScope('Western Cape',[pref]));
 }
 const html=fs.readFileSync(__dirname+'/index.html','utf8');
 const b=await chromium.launch({headless:true,executablePath:'/usr/local/bin/chromium',args:['--no-sandbox']});const p=await b.newPage();
 try{
  await p.setContent('<select id="mLoc"></select><div id="matchGrid"></div><div id="jmTitle"></div><div id="jmBody"></div><div id="jobModal" class="hidden"></div>');
  const helpers=html.slice(html.indexOf('const _locNorm ='),html.indexOf('function isVisibleMatch('));
  const render=html.slice(html.indexOf('function isVisibleMatch('),html.indexOf('let lastFilteredIds=[];'));
  const viewer=html.slice(html.indexOf('function scopeJobSections(value){'),html.indexOf("$$('.modal').forEach"));
  await p.addScriptTag({content:`var $=s=>document.querySelector(s);var esc=s=>String(s??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');var ZA_PROVINCES=['Gauteng','Western Cape'],SA_LOCATIONS=['Pretoria'];var currentSeeker={preferred_locations:['GAuteng za']};var state={view:'matches',mLoc:'GAuteng za',mQ:'',selected:new Set()};var matches=['Gauteng','GAuteng za','Gauteng south africa','Western Cape'].map((location,i)=>({id:String(i),location,status:'pending',job_title:'Office role',discovered_at:'2026-10-10T12:00:00Z'}));var lastFilteredIds=[];var isSkippedMatch=()=>false,statusPill=()=>'',employerLabel=j=>j.company_name||'',coLabel=s=>s||'',updateBulkBar=()=>{},discoveryDate=()=>'',timeAgo=()=>'',noteBox=()=>'';`+helpers+render+viewer});
  await p.evaluate(()=>renderMatches());assert.equal(await p.locator('.mcard').count(),3);assert.equal(await p.locator('#mLoc option').filter({hasText:/^Gauteng$/}).count(),1);assert.equal(await p.evaluate(()=>state.mLoc),'Gauteng');
  const desc=String.raw`Minimum applicable experience (years):\n• 1\&ndash;2 years\&rsquo; experience in a reception or office administration role.`.replace('\\n','\n');
  await p.evaluate(desc=>openJobView({job_title:'Reception &amp; Admin',location:'GAuteng za',job_description:desc}),desc);
  const text=await p.locator('#jmBody').innerText();assert(text.includes('1–2 years’ experience'));assert(!text.includes('&ndash;'));assert(!text.includes('\\'));assert(text.includes('Gauteng'));assert.equal(await p.locator('#jmTitle').innerText(),'Reception & Admin');
  assert.equal(await p.evaluate(()=>cleanJobText('1&amp;ndash;2 years&#8217; experience')),'1–2 years’ experience');
  await p.evaluate(()=>openJobView({job_description:'&lt;img src=x onerror="window.injected=1"&gt; &amp; useful'}));assert.equal(await p.locator('#jmBody img').count(),0);assert.equal(await p.evaluate(()=>window.injected),undefined);
  assert.equal(await p.evaluate(()=>canonicalLocationLabel('Johannesburg, Gauteng, ZA')),'Johannesburg, Gauteng, ZA');
  console.log('PASS Gauteng aliases share one dropdown/filter/preference; province cities match in worker; other provinces remain separate; escaped and double-encoded entities cleaned; source HTML remains inert text');
 }finally{await b.close();}
})().catch(e=>{console.error(e);process.exit(1)});
