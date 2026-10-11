const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const http=require('node:http');
const flow=require('./applicationFlow');
async function main(){
 const negatives=[
  'Please note that applications must be submitted prior to the close of the recruitment.',
  'A complete, all-inclusive application maximizes an applicant’s potential to qualify.',
  'Only applicants that follow the application instructions and submit completed applications will be considered.',
  'Thank you for your interest in our company.',
  'Once your application has been submitted, we will contact you.',
  'Your application has not been submitted.'
 ];
 for(const n of negatives)assert.equal(flow.findConfirmationText(n),null);
 for(const p of ['Your application has been submitted.','We have received your application.','Thank you for applying.','You have successfully applied.'])assert(flow.findConfirmationText(p));
 assert(flow.isAggregatorUrl('https://www.adzuna.com/details/123'));assert(flow.isAggregatorUrl('https://www.adzuna.co.za/land/ad/1'));assert(!flow.isAggregatorUrl('https://boards.greenhouse.io/stripe/jobs/1'));
 assert(!flow.actionableError(new Error('elementHandle.click: Timeout: element is not visible')).includes('no longer exists'));
 console.log('PASS strict receipt positives/negatives, aggregator domains, accurate error messages');
 // No real websites, APIs or application submissions are used below.
 let chromium;
 try { chromium=require('playwright').chromium; }
 catch { chromium=require('/data/application-tests/node_modules/playwright').chromium; }
 const fixtures={
  '/advert':'<a href="/employer">Apply now</a><form><input type="email" placeholder="Job alerts"><button>Subscribe</button></form>',
  '/employer':'<form><input name="name" required><input type="email" required><button type="submit">Submit application</button></form>',
  '/frame':'<form><input name="name"><input type="email" id="frameEmail"><button type="submit">Submit application</button></form>',
  '/popup':'<a target="_blank" href="/employer">Apply now</a>'
 };
 const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end(fixtures[req.url]||'<body></body>');});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const base='http://127.0.0.1:'+server.address().port;
 const executable=process.env.CHROMIUM_PATH||require('node:child_process').execSync('command -v chromium').toString().trim();
 const browser=await chromium.launch({headless:true,executablePath:executable,args:['--no-sandbox']});
 const context=await browser.newContext();const page=await context.newPage();
 try {
  await page.goto(base+'/employer');
  await page.setContent('<form style="display:none"><input type="email" id="hidden"></form><form><input name="name"><input id="visible" type="email"><button type="submit">Submit application</button></form>');
  assert.equal(await (await flow.firstUsableAcrossFrames(page,'input[type="email"]')).getAttribute('id'),'visible');
  console.log('PASS hidden duplicate controls are skipped');
  await page.setContent('<form><input type="email" id="newsletter"><button>Subscribe</button></form><form><input name="name"><input type="email" id="application"><input type="file" style="display:none" id="upload"><button type="submit">Submit application</button></form>');
  assert.equal(await (await flow.firstUsableAcrossFrames(page,'input[type="email"]')).getAttribute('id'),'application');
  assert(await flow.firstUsableAcrossFrames(page,'input[type="file"]'));
  const fields=await flow.applicationFields(page);assert(!fields.some(f=>f.id==='newsletter'));assert(fields.some(f=>f.id==='upload'));
  console.log('PASS application form preferred over newsletter; real hidden upload accepted');
  await page.setContent('<form><input name="name" value="Test"><input type="email" value="test@example.com"><select name="country" required><option value="">Choose</option><option>US</option></select><input type="checkbox" name="consent" required><button type="submit">Submit application</button></form>');
  const errors=await flow.requiredErrors(page);assert(errors.includes('country'));assert(errors.includes('consent'));
  console.log('PASS empty required selects and checkboxes block submission');
  await page.setContent('<button>Apply now</button><form><input name="name"><input type="email"><button type="submit">Submit application</button></form>');
  await flow.applicationFields(page);assert.equal((await flow.findStepButton(page)).isFinal,true);assert.equal(await (await flow.findStepButton(page)).el.textContent(),'Submit application');
  console.log('PASS outside Apply navigation is not a final submit control');
  await page.setContent('<form><input name="name"><input type="email"><button>Review application</button><button type="submit">Submit application</button></form>');
  assert.equal((await flow.findStepButton(page)).isFinal,false);
  console.log('PASS Review/Continue is a form step, not final submission');
  await page.goto(base+'/advert');
  const wrapped=new Proxy(page,{get(t,k){if(k==='url')return ()=>t.url().endsWith('/advert')?'https://www.adzuna.com/details/1':t.url();const v=t[k];return typeof v==='function'?v.bind(t):v;}});
  const reached=await flow.reachApplicationPage(wrapped);assert(reached.ok);assert(reached.page.url().endsWith('/employer'));
  console.log('PASS advert follows Apply to the actual form');
  await page.goto(base+'/popup');const popupWrapped=new Proxy(page,{get(t,k){if(k==='url')return ()=>t.url().endsWith('/popup')?'https://www.adzuna.com/details/2':t.url();const v=t[k];return typeof v==='function'?v.bind(t):v;}});
  const popupReached=await flow.reachApplicationPage(popupWrapped);assert(popupReached.ok);assert.notEqual(popupReached.page,page);await popupReached.page.close();
  console.log('PASS Apply popups/new tabs are followed');
  await page.setContent('<p>No employer application link</p>');const noLink=new Proxy(page,{get(t,k){if(k==='url')return ()=>'https://www.adzuna.com/details/3';const v=t[k];return typeof v==='function'?v.bind(t):v;}});
  assert(!(await flow.reachApplicationPage(noLink)).ok);
  console.log('PASS advert with no employer link is handed off, not submitted');
  await page.goto(base+'/employer');await page.setContent('<iframe src="'+base+'/frame"></iframe>');await page.waitForTimeout(200);
  assert.equal(await (await flow.firstUsableAcrossFrames(page,'input[type="email"]')).getAttribute('id'),'frameEmail');
  assert((await flow.applicationFields(page)).some(f=>f.id==='frameEmail'));
  console.log('PASS usable form fields are found inside child frames');
  await page.setContent('<p>Your application has been submitted.</p>');const before=await flow.snapshotReceiptPage(page);
  assert(!(await flow.waitForReceipt(page,before,{timeoutMs:50,pollMs:10})).ok);
  console.log('PASS pre-existing success wording is not new submission proof');
  await page.setContent('<p>Job description</p>');const baseline=await flow.snapshotReceiptPage(page);
  await page.evaluate(()=>{document.body.innerHTML='<p>Your application has been received.</p>';});
  assert((await flow.waitForReceipt(page,baseline,{timeoutMs:80,pollMs:10})).ok);
  console.log('PASS fresh explicit receipt on the application site is accepted');
  const src=fs.readFileSync(__dirname+'/apply.js','utf8');const begin=src.indexOf('async function verifySubmission('),end=src.indexOf('async function detectCaptcha(',begin);
  const sandbox=vm.createContext({applicationFlow:flow,handleCaptcha:async()=>null,humanDelay:async()=>{},snapshotSubmittedFields:async()=>[],storeConfirmationScreenshot:async()=>null,extractReference:()=>null});
  vm.runInContext(src.slice(begin,end),sandbox);
  await page.setContent('<form><input name="name" required><input type="email" required><button type="submit" onclick="document.body.innerHTML=\'Your application has been submitted.\';return false;">Submit application</button></form>');
  let result=await sandbox.submitAndVerify(page,await page.$('button'),[],{},{});assert.equal(result.safeToFill,true);assert(!result.ok);
  await page.fill('[name=name]','Test');await page.fill('[type=email]','test@example.com');
  result=await sandbox.submitAndVerify(page,await page.$('button'),[],{},{});assert(result.ok);assert.equal(result.evidence.verification_status,'confirmed');
  console.log('PASS worker blocks empty required fields and confirms only after a successful local submit');
  await page.setContent('<form><input name="name" value="Test"><input type="email" value="test@example.com"><button>Submit application</button></form>');
  const failBtn={scrollIntoViewIfNeeded:async()=>{},click:async()=>{throw new Error('click failed');}};
  result=await sandbox.submitAndVerify(page,failBtn,[],{},{});assert(result.unverified);assert(!result.ok);
  console.log('PASS failed click is not swallowed or marked successful');
  const runStart=src.indexOf('async function run() {',src.indexOf('let applyRunInProgress=false;'));
  const runEnd=src.indexOf('module.exports',runStart);const disabled=vm.createContext({console:{log(){}}});vm.runInContext(src.slice(runStart,runEnd),disabled);
  assert.equal((await disabled.run()).mode,'admin_only');
  console.log('PASS automatic runner disabled in admin-only workflow');
  const web=fs.readFileSync(__dirname+'/index.html','utf8');const fstart=web.indexOf('function isConfirmedApplication('),fend=web.indexOf('\n}\n',fstart)+3;
  const ws=vm.createContext({URL});vm.runInContext(web.slice(fstart,fend),ws);
  assert(!ws.isConfirmedApplication({result:'success',verification_status:'confirmed',confirmation_text:negatives[0],confirmation_url:'https://www.adzuna.com/details/1'}));
  assert(ws.isConfirmedApplication({result:'success',verification_status:'confirmed',confirmation_text:'Your application has been received.',confirmation_url:'https://careers.example.test/receipt'}));
  console.log('PASS frontend rejects instructional and aggregator success evidence');
  await page.setContent('<div id="appList"></div>');
  const renderStart=web.indexOf('function renderApplications('),renderEnd=web.indexOf('\nfunction applicationDetails(',renderStart);
  await page.addScriptTag({content:'const applications=[{id:"old",result:"success",verification_status:"confirmed",confirmation_text:"Applications must be submitted prior to closing",confirmation_url:"https://www.adzuna.com/details/1",attempted_at:"2026-10-11",job_matches:{job_title:"Example job",company_name:"Example"}},{id:"bad",result:"submission_unverified",notes:"No new receipt",attempted_at:"2026-10-11",job_matches:{job_title:"Other job",company_name:"Example"}}];const ATTENTION_META={submission_unverified:{label:"Submission not verified"}};const $=s=>document.querySelector(s);const esc=s=>String(s||"").replaceAll("<","&lt;");const employerLabel=m=>m.company_name;const fmtStamp=s=>s;'+web.slice(fstart,fend)+'\n'+web.slice(renderStart,renderEnd)});
  await page.evaluate(()=>renderApplications());
  const rendered=await page.locator('#appList').innerText();assert(rendered.includes('No completed applications recorded yet'));assert(!rendered.includes('No new receipt'));assert(!rendered.includes('Previous success needs review'));
  console.log('PASS Applied matches excludes failures and unsupported historical confirmations');

 } finally {await browser.close();await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
