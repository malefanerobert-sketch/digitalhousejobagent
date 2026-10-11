const assert=require('node:assert/strict'),fs=require('fs'),vm=require('vm');
const root=__dirname;
async function main(){
 const worker=fs.readFileSync(root+'/index.js','utf8');let watched=0,auto=0,schedules=[];
 const ctx=vm.createContext({require:n=>{if(n==='dotenv')return {config(){}};if(n==='node-cron')return {schedule:(spec,fn)=>schedules.push({spec,fn})};if(n==='./discoverWatched')return {run:async()=>watched++};if(n==='./discoverAuto')return {run:async()=>auto++};throw Error('Unexpected worker dependency '+n);},process:{env:{APPLY_CRON:'* * * * *'},stdin:{resume(){}}},console:{log(){},error(){}}});
 vm.runInContext(worker,ctx);assert.equal(schedules.length,2);assert.equal(watched,1);assert.equal(auto,1);for(const c of schedules)c.fn();assert.equal(watched,2);assert.equal(auto,2);
 console.log('PASS worker starts/schedules discovery only, even with APPLY_CRON set');
 const submitter=fs.readFileSync(root+'/apply.js','utf8');const a=submitter.indexOf('async function run() {',submitter.indexOf('let applyRunInProgress'));const b=submitter.indexOf('module.exports',a);const c=vm.createContext({console:{log(){}}});vm.runInContext(submitter.slice(a,b),c);assert.equal((await c.run()).mode,'admin_only');
 console.log('PASS direct application runner is disabled');
 const web=fs.readFileSync(root+'/index.html','utf8'),admin=fs.readFileSync(root+'/admin.html','utf8');
 let chromium;try{chromium=require('playwright').chromium;}catch(_){chromium=require('/data/application-tests/node_modules/playwright').chromium;}
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/local/bin/chromium',args:['--no-sandbox']});const page=await browser.newPage();
 try{
  await page.setContent('<select id="mLoc"></select><div id="matchGrid"></div><div id="appList"></div>');
  const bootstrap=`var currentSeeker={id:'seeker',preferred_locations:['Johannesburg']};var matches=[{id:'local',status:'pending',location:'Johannesburg',job_title:'Local discovery',discovered_at:'2026-10-01T12:00:00Z'},{id:'skip',status:'skipped',agent_skipped_at:'2026-10-02',skip_reason:'Outside preference',location:'India',job_title:'Skipped job',discovered_at:'2026-10-02T12:00:00Z'},{id:'failed',status:'failed',location:'Japan',job_title:'Failed job',discovered_at:'2026-10-03T12:00:00Z'},{id:'uncertain',status:'submission_unverified',location:'US',job_title:'Uncertain job',discovered_at:'2026-10-04T12:00:00Z'},{id:'done',status:'applied',location:'London',job_title:'Applied job',discovered_at:'2026-10-05T12:00:00Z'}];var state={view:'matches',mLoc:'all',mQ:'',selected:new Set()};var SA_LOCATIONS=[],US_LOCATIONS=[],ZA_PROVINCES=[],lastFilteredIds=[],openNotes=new Set();var $=s=>document.querySelector(s);var esc=s=>String(s||'');var isBlocked=()=>true;var employerLabel=m=>m.company_name;var coLabel=s=>s||'';var noteBox=(c,id,t,ch)=>'<div>'+t+ch+'</div>';var matchDisplayTime=()=>'';var timeAgo=()=>'';var updateBulkBar=()=>{};var renderDashboard=()=>{};var toast=()=>{};var refreshApplicationReadiness=async()=>({ready:true,missing:[]});var setView=()=>{};var calls=[];var sb={rpc:async(name,args)=>{calls.push({name,args});return {error:null}}};`;
  const start=web.indexOf('function isSkippedMatch'),end=web.indexOf('\nvar openNotes',start);const loc=web.indexOf('const _locNorm'),rend=web.indexOf('\nlet lastFilteredIds=',loc);const h=web.indexOf("$('#matchGrid').addEventListener('click', async (e)=>"),he=web.indexOf('\n/* ================= APPLICATIONS',h);
  await page.addScriptTag({content:bootstrap+web.slice(start,end)+web.slice(loc,rend)+web.slice(h,he)});await page.evaluate(()=>renderMatches());
  assert.equal(await page.locator('.mcard').count(),5);assert(!(await page.locator('#matchGrid').innerText()).includes('ago'));assert((await page.locator('#matchGrid').innerText()).includes('Discovered 01 Oct 2026'));assert.equal(await page.locator('button[data-action=apply][data-id=uncertain]').count(),0);
  console.log('PASS all discovered records/countries/statuses persist with calendar dates; uncertain job not blindly requeued');
  await page.evaluate(()=>{state.view='skipped';renderMatches()});assert.equal(await page.locator('.mcard').count(),1);await page.click('button[data-action=apply][data-id=skip]');assert.equal(await page.locator('.mcard').count(),1);assert((await page.locator('#matchGrid').innerText()).includes('Queued for admin'));
  const call=await page.evaluate(()=>calls[0]);assert.equal(call.name,'request_job_application');assert.equal(call.args.p_match_id,'skip');
  await page.evaluate(()=>{matches.find(m=>m.id==='skip').status='applied';renderMatches()});assert.equal(await page.locator('.mcard').count(),0);await page.evaluate(()=>{state.view='matches';renderMatches()});assert.equal(await page.locator('.mcard').count(),5);
  console.log('PASS skipped request stays skipped/queued until applied; completion never reduces discoveries');
  const cs=web.indexOf('function isConfirmedApplication'),ce=web.indexOf('\nconst ATTENTION_META',cs),rs=web.indexOf('function renderApplications'),re=web.indexOf('\nfunction applicationDetails',rs);
  await page.addScriptTag({content:`var applications=[{id:'ok',job_match_id:'skip',result:'success',verification_status:'admin_confirmed',attempted_at:'2026-10-11',job_matches:{job_title:'Skipped job'}},{id:'duplicate',job_match_id:'skip',result:'success',verification_status:'admin_confirmed',attempted_at:'2026-10-11'},{id:'bad',result:'submission_unverified'},{id:'attempt',result:'failed'}];`+web.slice(cs,ce)+web.slice(rs,re)});await page.evaluate(()=>renderApplications());assert.equal(await page.locator('#appList .lrow').count(),1);assert((await page.locator('#appList').innerText()).includes('Admin confirmed'));assert(!(await page.locator('#appList').innerText()).includes('Attempts needing review'));
  console.log('PASS Applied matches shows completed unique jobs only, with admin attribution');
  // Verify pagination of permanent discoveries (more than Supabase's default 1000 rows).
  const loaderStart=web.indexOf('async function loadMatches'),loaderEnd=web.indexOf('\nfunction isSkippedMatch',loaderStart);
  await page.addScriptTag({content:web.slice(loaderStart,loaderEnd)});
  await page.evaluate(()=>{var rows=Array.from({length:1201},(_,i)=>({id:String(i),job_title:'Fixture '+i,status:i%2?'failed':'pending'}));window.rangeCalls=[];sb={from:()=>({select(){return this},eq(){return this},order(){return this},range:async(a,b)=>{rangeCalls.push([a,b]);return {data:rows.slice(a,b+1),error:null}}})};});await page.evaluate(()=>loadMatches());assert.equal(await page.evaluate(()=>matches.length),1201);assert.equal((await page.evaluate(()=>rangeCalls)).length,3);
  console.log('PASS permanent discovery loader pages beyond 1000 records');
  // Test admin form without accessing any employer or real database.
  await page.setContent('<div id="applyBody"></div>');
  const fsx=admin.indexOf('function adminOutcomeForm'),fex=admin.indexOf('// Compact "label',fsx);
  await page.addScriptTag({content:`var writes=[];var sb={rpc:async(n,a)=>{writes.push({name:n,args:a});return {error:null}}};var closeApplyModal=()=>{};var loadReport=async()=>{};`+admin.slice(fsx,fex)});
  await page.evaluate(()=>document.getElementById('applyBody').innerHTML=adminOutcomeForm({id:'fixture',status:'pending',application_log:[]}));
  await page.fill('#adminReceiptText','Your application has been received.');await page.fill('#adminReceiptUrl','https://employer.example/receipt');await page.click('#adminOutcomeSave');assert.equal(await page.evaluate(()=>writes.length),0);
  await page.check('#adminReceiptChecked');await page.click('#adminOutcomeSave');assert.equal(await page.evaluate(()=>writes.length),1);assert.equal((await page.evaluate(()=>writes[0])).args.p_outcome,'success');assert.equal((await page.evaluate(()=>writes[0])).args.p_receipt_checked,true);
  console.log('PASS admin success requires checked employer receipt; saved via permission-checked RPC');
  await page.evaluate(()=>document.getElementById('applyBody').innerHTML=adminOutcomeForm({id:'fixture',status:'submission_unverified',application_log:[]}));assert((await page.locator('#applyBody').innerText()).includes('Do not send a duplicate'));await page.selectOption('#adminOutcome','failed');await page.click('#adminOutcomeSave');assert.equal(await page.evaluate(()=>writes.length),1);await page.fill('#adminOutcomeNotes','Employer form unavailable');await page.click('#adminOutcomeSave');assert.equal(await page.evaluate(()=>writes.length),2);
  console.log('PASS failed outcome needs notes and uncertain submission warns against duplication');
 }finally{await browser.close();}
 console.log('ALL ADMIN WORKFLOW TESTS PASSED — no real applications or database writes');
}
main().catch(e=>{console.error(e);process.exit(1)});
