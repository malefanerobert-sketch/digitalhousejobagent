'use strict';
const fs=require('node:fs');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const web=fs.readFileSync(__dirname+'/index.html','utf8');
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/local/bin/chromium',args:['--no-sandbox']});
 try{
  const p=await browser.newPage();
  await p.setContent('<div id="jmTitle"></div><div id="jmBody"></div><div id="jobModal" class="modal hidden"></div>');
  const helpers=web.slice(web.indexOf('const _locNorm ='),web.indexOf('const _JHB_METRO='));
  const employers=web.slice(web.indexOf('const SOURCE_NAME_RE'),web.indexOf('function isSouthAfricanMatch'));
  const viewer=web.slice(web.indexOf('function scopeJobSections(value){'),web.indexOf("$$('.modal').forEach"));
  await p.addScriptTag({content:`var $=s=>document.querySelector(s);var ZA_PROVINCES=[];var esc=s=>String(s||'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');var timeAgo=()=>'';var completedApplicationForJob=()=>null;var applicationDetailsMarkup=()=>'';var currentSeeker={id:'seeker-1'};`+helpers+employers+viewer});
  const advert='About the company\nActual Employer provides financial services.\nIntroduction\nWe invite applications for a role managing important records.\nResponsibilities\n'+Array.from({length:900},(_,i)=>'• Duty '+i+' must remain visible.').join('\n')+'\nQualifications\n• Grade 12 and a diploma.\nExperience\n• Three years.\nBenefits\n• Medical aid and pension.\nWorking arrangement\nHybrid, with occasional weekend duties.\nSalary\nR20,000–R25,000 per month.\nClosing date: 2026-11-30\nHow to apply\nVisit PNet, JobMail, Careers24, Adzuna or CareerJunction https://www.pnet.co.za/secret\nRequired documents\nCVs must be accompanied by certified copies of ID and qualifications.\nEmployment type: FULL_TIME\nFINAL ADVERT FACT';
  await p.evaluate(description=>openJobView({job_title:'Finance Officer',employer_name:'Actual Employer',company_name:'Adzuna',job_description:description,job_description_status:'captured'}),advert);
  const text=await p.locator('#jmBody').innerText();
  for(const fact of ['Actual Employer','financial services','invite applications','Duty 0','Duty 899','Grade 12 and a diploma','Three years','Medical aid and pension','Hybrid, with occasional weekend duties','R20,000–R25,000','2026-11-30','certified copies','FINAL ADVERT FACT'])assert(text.includes(fact),fact);
  assert(!/adzuna|pnet|jobmail|careers24|careerjunction|https?:/i.test(text));
  assert.equal(await p.locator('#jmBody a').count(),0);
  await p.evaluate(()=>openJobView({job_description:'Requirements\n<img src=x onerror="window.injected=1">',job_description_status:'captured'}));
  assert.equal(await p.locator('#jmBody img').count(),0);
  // Simulate a tab's stale match object and a completed background refresh.
  await p.evaluate(()=>{
   window.queries=[];window.resolveDetail=null;
   window.sb={from:table=>{queries.push(['from',table]);const q={select:fields=>{queries.push(['select',fields]);return q;},eq:(k,v)=>{queries.push(['eq',k,v]);return q;},maybeSingle:()=>new Promise(r=>{resolveDetail=r;})};return q;}};
   openJobView({id:'match-1',job_title:'Old title',job_description:'Old summary…',job_description_status:'limited'});
  });
  assert((await p.locator('#jmBody').innerText()).includes('Checking for updated job details'));
  await p.evaluate(()=>resolveDetail({data:{id:'match-1',job_title:'Updated title',employer_name:'Actual Employer',job_description:'Responsibilities\nComplete advert retrieved after the tab opened.\nQualifications\nDiploma.',job_description_status:'captured'}}));
  await p.waitForFunction(()=>document.querySelector('#jmTitle').textContent==='Updated title');
  assert((await p.locator('#jmBody').innerText()).includes('Complete advert retrieved'));
  const queries=await p.evaluate(()=>queries);
  assert(queries.some(x=>x[0]==='eq'&&x[1]==='job_seeker_id'&&x[2]==='seeker-1'));
  assert(!queries.find(x=>x[0]==='select')[1].includes('job_url'));
  // An earlier network response must never replace a different job's modal.
  await p.evaluate(()=>{openJobView({id:'match-A',job_title:'A',job_description:'A summary'});window.resolveA=resolveDetail;openJobView({job_title:'B',job_description:'B details'});resolveA({data:{job_title:'Wrong stale response',job_description:'Wrong details'}});});
  await p.waitForTimeout(25);assert.equal(await p.locator('#jmTitle').innerText(),'B');
  // A closed modal must stay closed when its request completes.
  await p.evaluate(()=>{openJobView({id:'match-C',job_title:'C'});document.querySelector('#jobModal').classList.add('hidden');resolveDetail({data:{job_title:'C refreshed'}});});
  await p.waitForTimeout(25);assert(await p.locator('#jobModal').evaluate(el=>el.classList.contains('hidden')));
  // Failures retain the usable saved summary and show no backend error details.
  await p.evaluate(()=>{openJobView({id:'match-D',job_description:'Saved summary remains available.'});resolveDetail({error:{message:'Secret source URL'}});});
  await p.waitForFunction(()=>document.querySelector('#jmBody').textContent.includes('Could not check for updates'));
  assert((await p.locator('#jmBody').innerText()).includes('Saved summary remains available'));
  assert(!(await p.locator('#jmBody').innerText()).includes('Secret source'));
  console.log('PASS complete long advert, employer, duties, qualifications, salary, benefits, unknown sections and required documents; source privacy; safe rendering; fresh scoped reload; stale response/closed modal protection; offline fallback');
  // Render the actual modal styles at desktop and phone widths without networking.
  const css=web.match(/<style>([\s\S]*?)<\/style>/)[1];
  await p.addStyleTag({content:css});
  await p.evaluate(description=>{delete window.sb;document.querySelector('#jmTitle').remove();document.querySelector('#jmBody').remove();document.querySelector('#jobModal').innerHTML='<div class="modal-card"><div class="modal-head"><h3 id="jmTitle"></h3><button class="x-btn">✕</button></div><div id="jmBody"></div></div>';openJobView({job_title:'Finance Officer',employer_name:'Actual Employer',location:'Johannesburg',job_description:description,job_description_status:'captured'});},advert);
  for(const [width,height,name] of [[1280,800,'desktop'],[390,844,'mobile']]){
   await p.setViewportSize({width,height});await p.waitForTimeout(300);
   const dims=await p.locator('#jobModal .modal-card').evaluate(el=>({scroll:el.scrollHeight,client:el.clientHeight,width:el.getBoundingClientRect().width,overflow:el.scrollWidth>el.clientWidth}));
   assert(dims.scroll>dims.client);assert(dims.width<=width);assert(!dims.overflow);
   await p.screenshot({path:require('node:path').join(process.env.JOB_VIEW_SCREENSHOT_DIR||require('node:os').tmpdir(),'job-view-'+name+'.png')});
  }
  console.log('PASS scrollable desktop and mobile modal; no horizontal overflow');
  const {captureJobDetails}=require('./jobDetails');
  const context=await browser.newContext();
  const body='Responsibilities\n'+Array.from({length:150},(_,i)=>'• Published duty '+i+' for financial administration.').join('\n');
  const posting={'@type':'JobPosting',title:'Finance Officer',hiringOrganization:{name:'Actual Employer'},description:'An overview of this position.',qualifications:{'@type':'EducationalOccupationalCredential',credentialCategory:'National Diploma in Accounting'},experienceRequirements:{'@type':'OccupationalExperienceRequirements',monthsOfExperience:36},jobBenefits:'Medical aid and pension.',baseSalary:{currency:'ZAR',value:{minValue:20000,maxValue:25000,unitText:'MONTH'}}};
  await context.route('https://detail-fixture.test/**',r=>r.fulfill({contentType:'text/html',body:'<h1>Finance Officer</h1><div class="job-description">'+body.replaceAll('\n','<br>')+'</div><script type="application/ld+json">'+JSON.stringify(posting)+'</script>'}));
  const captured=await captureJobDetails('https://detail-fixture.test/mixed',{browser:{newPage:()=>context.newPage()},title:'Finance Officer'});
  for(const fact of ['Published duty 149','National Diploma in Accounting','36 months of experience','Medical aid and pension','20000','25000'])assert(captured.description.includes(fact),fact);
  assert.equal(captured.employer,'Actual Employer');assert.equal(captured.status,'captured');
  console.log('PASS longer visible advert preserves separate structured employer, qualification, experience, salary and benefits facts');

 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
