const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('/data/application-tests/node_modules/playwright');
const {captureJobDetails,privateText,refreshSavedDescriptions}=require('./jobDetails');
(async()=>{
 const browser=await chromium.launch({headless:true,executablePath:'/usr/local/bin/chromium',args:['--no-sandbox']});
 try{
  const full='Responsibilities\n'+Array.from({length:1200},(_,i)=>'• Duty '+i+' — preserved verbatim.').join('\n')+'\nRequirements\nMatric and 1–2 years’ experience.\nClosing date: 30 October 2026.\nSALARY END MARKER';
  const template=(desc,title='Office Administrator',links='')=>'<meta charset="utf-8"><h1>'+title+'</h1><script type="application/ld+json">'+JSON.stringify({'@type':'JobPosting',title,hiringOrganization:{name:'Verified Employer'},description:desc})+'</script>'+links;
  const pages={'https://fixture.test/long':template(full),'https://fixture.test/summary':template('Short role summary from JobMail. https://www.pnet.co.za/jobs/abc #J-18808-Ljbffr'),'https://fixture.test/redirect':template('Brief role summary','Office Administrator','<a href="https://fixture.test/original">Apply for this job</a>'),'https://fixture.test/original':template(full)};
  await browser.newContext();const context=browser.contexts()[0];await context.route('https://fixture.test/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:pages[route.request().url()]||'<h1>Not found</h1>'}));
  const originalNew=browser.newPage.bind(browser);const borrowed={newPage:()=>context.newPage()};
  const got=await captureJobDetails('https://fixture.test/long',{browser:borrowed,title:'Office Administrator'});assert(got.description===full,'Full source text changed unexpectedly');assert.equal(got.status,'captured');assert(got.description.length>30000);
  const summary=await captureJobDetails('https://fixture.test/summary',{browser:borrowed,title:'Office Administrator'});assert.equal(summary.status,'limited');assert(summary.description.includes('Short role summary'));assert(!/jobmail|pnet|http|Ljbffr/i.test(summary.description));
  const followed=await captureJobDetails('https://fixture.test/redirect',{browser:borrowed,title:'Office Administrator'});assert(followed.description===full,'Original vacancy description mismatch');assert.equal(followed.status,'captured');
  assert(!/jobmail|pnet|careerjunction|adzuna|jobbi|jobrapido|http/i.test(privateText('Apply through JobMail, PNet, CareerJunction, Adzuna, Jobbi or Jobrapido. www.pnet.co.za adzuna.co.za https://example.test/secret')));
  console.log('PASS source text >30k characters and final salary/closing sections retained; original vacancy route followed without submission; summaries preserved and classified; provider names/URLs stripped');
  const web=fs.readFileSync(__dirname+'/index.html','utf8');const p=await browser.newPage();await p.setContent('<div id="jmTitle"></div><div id="jmBody"></div><div id="jobModal" class="hidden"></div>');
  const helpers=web.slice(web.indexOf('const _locNorm ='),web.indexOf('const _JHB_METRO='));
  const viewer=web.slice(web.indexOf('function openJobView(j){'),web.indexOf("$$('.modal').forEach"));
  const employers=web.slice(web.indexOf('const SOURCE_NAME_RE'),web.indexOf('function isSouthAfricanMatch'));
  await p.addScriptTag({content:`var $=s=>document.querySelector(s);var ZA_PROVINCES=['Gauteng'];var esc=s=>String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');var timeAgo=()=>'';`+helpers+employers+viewer});
  await p.evaluate(desc=>openJobView({job_description:desc,job_description_status:'captured',job_title:'Office Administrator',employer_name:'Verified Employer',company_name:'PNet'}),full);assert((await p.locator('#jmBody').innerText()).includes('SALARY END MARKER'));assert(!(await p.locator('#jmBody').innerText()).includes('PNet'));assert.equal(await p.locator('#jmBody a').count(),0);
  await p.evaluate(desc=>openJobView({job_description:desc,job_description_status:'limited',job_title:'Office Administrator',company_name:'JobMail'}),summary.description);const body=await p.locator('#jmBody').innerText();assert(body.toLowerCase().includes('available job summary'));assert(body.includes('Short role summary'));assert(!/jobmail|pnet|http/i.test(body));
  await p.evaluate(()=>openJobView({job_description:String.raw`Requirements\n1\&ndash;2 years\&rsquo; experience. &lt;img src=x onerror="window.bad=1"&gt; Apply via CareerJunction. https://www.careerjunction.co.za/123`,job_description_status:'legacy'}));assert.equal(await p.locator('#jmBody img').count(),0);assert(!(await p.locator('#jmBody').innerText()).includes('CareerJunction'));assert((await p.locator('#jmBody').innerText()).includes('1–2 years’ experience'));
  console.log('PASS full text reaches user viewer; available summaries stay visible; legacy source names/links redacted; entity decoding remains safe');
  let patch=null;const row={id:'existing',job_url:'https://fixture.test/redirect',job_title:'Office Administrator',job_description:'Short existing description',job_description_status:'legacy'};
  const select={neq(){return this},or(){return this},order(){return this},async limit(){return {data:[row]}}};const sb={from:()=>({select:()=>select,update:v=>({eq:async()=>{patch=v;return {}}})})};await refreshSavedDescriptions(sb,{browser:borrowed});assert(patch.job_description===full,'Existing row did not receive full description');assert.equal(patch.job_description_status,'captured');assert.deepEqual(Object.keys(patch).sort(),['job_description','job_description_checked_at','job_description_status']);
  console.log('PASS existing description refresh preserves match IDs, discovery dates, application statuses and counts');
 }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exit(1)});
