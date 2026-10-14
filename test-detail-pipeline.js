'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {captureJobDetails,storedJobDetails,refreshSavedDescriptions,CAPTURE_VERSION}=require('./jobDetails');
const {mockDetailsDatabase}=require('./test-detail-db');
(async()=>{
 const richer='A published feed with qualifications and benefits. '.repeat(150);
 assert.equal(storedJobDetails({description:'Brief…',status:'limited'},richer).job_description,richer.trim());
 assert.equal(storedJobDetails({status:'unavailable'},richer).job_description_status,'limited');
 for(const source of ['Adzuna','PNet','Job Mail','Careers24','CareerJunction','Via Jobmail'])assert.equal(storedJobDetails({employer:source},'',source).employer_name,null);
 assert.equal(storedJobDetails({employer:'Actual Employer'},'', 'PNet').employer_name,'Actual Employer');
 assert.equal(storedJobDetails({}).job_description_status,'unavailable');
 const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||'/usr/local/bin/chromium',args:['--no-sandbox']});
 try{
  const context=await browser.newContext();const hits={};
  const full='Responsibilities\n'+('• Keep the complete published duty, without rewriting.\n'.repeat(100))+'\nQualifications\nAccounting diploma.\nSalary\nZAR 20000 per month.\nBenefits\nMedical aid.\nClosing date: 2026-11-30';
  await context.route('https://pipeline-fixture.test/**',route=>{
   const path=new URL(route.request().url()).pathname;hits[path]=(hits[path]||0)+1;
   if(path==='/failed')return route.fulfill({status:503,body:'Unavailable'});
   // JobPosting nested in WebPage.mainEntity, not merely top-level/@graph.
   const posting={'@type':'WebPage',mainEntity:{'@type':'JobPosting',title:'Finance Officer',description:full,hiringOrganization:{name:'Actual Employer'}}};
   return route.fulfill({contentType:'text/html; charset=utf-8',body:'<h1>Finance Officer</h1><script type="application/ld+json">'+JSON.stringify(posting)+'</script>'});
  });
  const borrowed={newPage:()=>context.newPage()};
  const concurrent=await Promise.all([captureJobDetails('https://pipeline-fixture.test/concurrent',{browser:borrowed,title:'Finance Officer'}),captureJobDetails('https://pipeline-fixture.test/concurrent?utm_source=duplicate',{browser:borrowed,title:'Finance Officer'})]);
  assert.equal(hits['/concurrent'],1);assert.equal(concurrent[0].description,full);assert.equal(concurrent[1].description,full);
  const rows=Array.from({length:150},(_,i)=>({id:'a'+String(i).padStart(4,'0'),job_title:'Finance Officer',job_url:'https://pipeline-fixture.test/shared',job_description:'Old summary…',job_description_status:i===0?null:'limited',job_description_capture_version:0,status:'skipped',discovered_at:'2026-10-01T00:00:00Z'}));
  rows.push({id:'a9999',job_title:'Finance Officer',job_url:'https://pipeline-fixture.test/shared',job_description:full+'\nAdditional existing verified fact.',job_description_status:'captured',job_description_capture_version:0});
  for(let i=0;i<6;i++)rows.push({id:'b'+i,job_title:'Finance Officer',job_url:'https://pipeline-fixture.test/job-'+i,job_description_status:'captured',job_description_capture_version:0});
  rows.push({id:'c0',job_title:'Finance Officer',job_url:'https://pipeline-fixture.test/failed',job_description:'Previously captured content that must survive a source failure.',job_description_status:'captured',job_description_capture_version:0});
  rows.push({id:'z0',job_title:'⚠ Watched page could not be read (not a job)',job_url:'https://pipeline-fixture.test/notice'});
  const db=mockDetailsDatabase(rows);
  await Promise.all([refreshSavedDescriptions(db,{browser:borrowed,limit:8}),refreshSavedDescriptions(db,{browser:borrowed,limit:8})]);
  assert(db.scans.length>=2,'Must scan beyond the first page of duplicate copies');
  assert.equal(hits['/shared'],1);assert.equal(hits['/notice'],undefined);assert.equal(db.records[0].job_description,full);assert.equal(db.records[0].job_description_capture_version,CAPTURE_VERSION);
  assert(db.records.find(r=>r.id==='a9999').job_description.includes('Additional existing verified fact'));
  const failed=db.records.find(r=>r.id==='c0');assert.equal(failed.job_description,rows.find(r=>r.id==='c0').job_description);assert.equal(failed.job_description_status,'captured');assert.equal(failed.job_description_capture_version,0);assert(failed.job_description_checked_at);
  assert.equal(db.records[0].status,'skipped');assert.equal(db.records[0].discovered_at,'2026-10-01T00:00:00Z');
  for(const {patch} of db.patches)for(const field of Object.keys(patch))assert(['job_description','job_description_status','job_description_capture_version','job_description_checked_at','employer_name'].includes(field),field);
  console.log('PASS nested structured adverts, concurrent URL dedup, 150 duplicate applicants, null/legacy/captured-old repair, employer repair, failure preservation, richer-copy preservation and immutable match/application metadata');
 }finally{await browser.close();}
 // Verify BOTH future-match paths persist the shared versioned details.
 for(const file of ['discoverAuto.js','discoverWatched.js']){
  const code=fs.readFileSync(__dirname+'/'+file,'utf8');new vm.Script(code);
  assert(code.includes('jobDetails.captureJobDetails('),file);assert(code.includes('jobDetails.storedJobDetails('),file);
  assert(!code.includes('cleanDescriptionWithAI'),file+' must not rewrite/truncate advert text');
 }
 // Scheduler is independent of new-job discovery but respects the master switch.
 let enabled=false,repairs=0;const schedules=[];
 const modules={'dotenv':{config(){}},'node-cron':{schedule:(pattern,callback)=>schedules.push({pattern,callback})},'./discoverWatched':{run:async()=>{}},'./discoverAuto':{run:async()=>{}},'./jobDetails':{refreshSavedDescriptions:async()=>{repairs++;}},'./supabaseClient':{},'./aiMatch':{loadSettings:async()=>{},isAgentEnabled:()=>enabled}};
 const sandbox={require:n=>modules[n],process:{env:{},stdin:{resume(){}}},console:{log(){},error(){}}};vm.runInNewContext(fs.readFileSync(__dirname+'/index.js','utf8'),sandbox);await new Promise(r=>setImmediate(r));assert.equal(repairs,0);
 const scheduled=schedules.find(x=>x.pattern==='*/15 * * * *');assert(scheduled);enabled=true;await scheduled.callback();assert.equal(repairs,1);
 console.log('PASS both discovery paths use shared complete storage; no legacy AI advert truncation; independent scheduled repair respects master switch');
})().catch(e=>{console.error(e);process.exitCode=1;});
