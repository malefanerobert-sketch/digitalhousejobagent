'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const details=require('./jobDetails');
(async()=>{
 const full='Role overview\nSupport the finance department with accurate reporting and administration.\nResponsibilities\n'+('• Reconcile records, maintain invoices and support month-end reporting.\n'.repeat(8))+'\nQualifications and requirements\nMatric and an accounting diploma. Two years of relevant experience.\nBenefits\nMedical aid.\nClosing date: 30 November 2026.';
 const ready=details.storedJobDetails({description:full,status:'captured',employer:'Actual Employer'});
 assert(details.canPublishJobDetails(ready,'Finance Officer'));
 for(const bad of [
  {...ready,job_description:'Rental Administrator'},
  {...ready,job_description_status:'limited'},
  {...ready,job_description_status:'unavailable'},
  {...ready,employer_name:null},
  {...ready,employer_name:'PNet'},
  {...ready,employer_name:'Company not listed'},
  {...ready,employer_name:'Confidential'},
  {...ready,job_description:full+'\nThis sentence is cut off…'},
  {...ready,job_description:full+'\nThis sentence is cut off...\nSalary\nZAR 20000'},
  {...ready,job_description:'Role overview\n'+('Support the finance department. '.repeat(40))},
  {...ready,job_description:'Qualifications\n'+('Diploma in accounting required. '.repeat(40))}
 ])assert(!details.canPublishJobDetails(bad,'Rental Administrator'));
 // No made-up salary requirement: a complete advert with an undisclosed salary
 // is allowed, while title-only/partial/unknown-employer pages are not.
 assert.equal(ready.salary_text,undefined);
 const auto=fs.readFileSync(__dirname+'/discoverAuto.js','utf8');
 const save=auto.slice(auto.indexOf('async function saveMatches('),auto.indexOf('/**\n * Main discovery loop'));
 const inserted=[];const sb={from:()=>({select:()=>({eq:async()=>({data:[]})}),upsert:rows=>({select:async()=>{inserted.push(...rows);return {data:rows};}})})};
 const statuses={good:{description:full,status:'captured',employer:'Actual Employer'},short:{description:'Rental Administrator',status:'limited',employer:null},cut:{description:full+'\nThe role continues…',status:'captured',employer:'Actual Employer'},noemployer:{description:full,status:'captured',employer:null}};
 const staged=[];const context={sb,candidateQueue:{deferCandidates:async(db,rows)=>staged.push(...rows)},zaScope:{isZAJob:()=>true,locationText:x=>x},jobDetails:{...details,captureJobDetails:async url=>statuses[url]},cleanHtml:x=>x,isPlaceholderCompany:x=>!x,console:{log(){}},Date,Set};vm.createContext(context);vm.runInContext(save+'\nglobalThis.save=saveMatches;',context);
 const jobs=Object.keys(statuses).map((url,i)=>({url,title:'Finance Officer '+i,company:url==='noemployer'?null:'Actual Employer',location:'Johannesburg',description:'A short feed summary',match_score:85}));
 assert.equal(await context.save('seeker-1',jobs),1);assert.equal(staged.length,3);assert.equal(inserted.length,1);assert.equal(inserted[0].job_url,'good');assert.equal(inserted[0].job_description,full);
 const watched=fs.readFileSync(__dirname+'/discoverWatched.js','utf8');
 const gate=watched.indexOf('if(!jobDetails.canPublishJobDetails(savedDetails,job.title))');const insert=watched.indexOf("supabase.from('job_matches').insert(matchRow)",gate);
 assert(gate>0&&insert>gate);assert(watched.slice(gate,insert).includes('continue;'));
 for(const file of ['discoverAuto.js','discoverWatched.js'])assert(fs.readFileSync(__dirname+'/'+file,'utf8').includes("if(process.env.REPAIR_EXISTING_JOB_DETAILS==='true')"));
 // Historical repair must not run on startup or a timer without opt-in.
 let enabled=true,repairs=0;const schedules=[];
 const modules={'./candidateQueue':{processCandidates:async()=>{}},'dotenv':{config(){}},'node-cron':{schedule:(pattern,callback)=>schedules.push({pattern,callback})},'./discoverWatched':{run:async()=>{}},'./discoverAuto':{run:async()=>{}},'./jobDetails':{refreshSavedDescriptions:async()=>{repairs++;}},'./supabaseClient':{},'./aiMatch':{loadSettings:async()=>{},isAgentEnabled:()=>enabled}};
 const sandbox={require:n=>modules[n],process:{env:{},stdin:{resume(){}}},console:{log(){},error(){}}};vm.runInNewContext(fs.readFileSync(__dirname+'/index.js','utf8'),sandbox);await new Promise(r=>setImmediate(r));assert.equal(repairs,0);
 const timer=schedules.find(x=>x.pattern==='*/15 * * * *');await timer.callback();assert.equal(repairs,0);sandbox.process.env.REPAIR_EXISTING_JOB_DETAILS='true';enabled=false;await timer.callback();assert.equal(repairs,0);enabled=true;await timer.callback();assert.equal(repairs,1);
 console.log('PASS future-only gate rejects title-only, partial, unavailable, source-labelled, missing-employer and cut-off adverts before publication; valid complete advert is saved without requiring undisclosed salary; both discovery paths gated; historical repair off by default');
})().catch(e=>{console.error(e);process.exitCode=1;});
