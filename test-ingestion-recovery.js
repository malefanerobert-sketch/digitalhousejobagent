'use strict';
const assert=require('node:assert/strict');
const {createBrowserRuntime}=require('./jobBrowser');
const queue=require('./candidateQueue');
const details=require('./jobDetails');
const full='Role overview\nSupport the finance department with accurate reporting and administration.\nResponsibilities\n'+('Reconcile records, maintain invoices and support month-end reporting.\n'.repeat(9))+'Qualifications and requirements\nMatric and accounting diploma. Two years relevant experience.';
const complete={description:full,status:'captured',employer:'Actual Employer'};
const fit={titleSkipReason:()=>null,locationInScope:()=>true,skipMessage:x=>x};
const scope={isZAJob:row=>row.location==='Johannesburg'||row.country_code==='ZA'};
const clone=x=>JSON.parse(JSON.stringify(x));
function database(){
 let id=0;const tables={job_discovery_candidates:[],job_matches:[],job_seekers:[{full_name:'Synthetic Applicant',date_of_birth:'1990-01-01',gender:'Other',id_type:'passport',id_number:'FIXTURE123',nationality:'South African',phone:'0123456789',job_title_keywords:['Finance Officer'],apply_qualifications:['Diploma'],apply_experience_ranges:['0-1'],id:'u1',status:'active',auto_search_enabled:true,discovery_mode:'both',api_provider:'shared',blocked_companies:[],preferred_locations:[]}],job_sources:[{id:'s1',active:true}],user_job_sources:[{user_id:'u1',job_source_id:'s1',enabled:true}],job_custom_sources:[],job_custom_source_optouts:[]};
 let failInsert=false;
 return {tables,failNextInsert(){failInsert=true;},from(table){
  let action='select',values,opts={},filters=[],max=Infinity,single=false,sorts=[];
  const b={select(){return b;},eq(k,v){filters.push(r=>r[k]===v);return b;},lte(k,v){filters.push(r=>r[k]<=v);return b;},order(k,{ascending=true}={}){sorts.push([k,ascending]);return b;},limit(n){max=n;return b;},maybeSingle(){single=true;return b;},upsert(v,o){action='upsert';values=Array.isArray(v)?v:[v];opts=o||{};return b;},update(v){action='update';values=v;return b;},delete(){action='delete';return b;},then(resolve,reject){return Promise.resolve().then(()=>{
   if(!tables[table])throw new Error('Unexpected table '+table);
   let selected=tables[table].filter(r=>filters.every(f=>f(r)));
   selected.sort((a,b)=>{for(const [k,asc] of sorts){if(a[k]<b[k])return asc?-1:1;if(a[k]>b[k])return asc?1:-1;}return 0;});selected=selected.slice(0,max);
   if(action==='upsert'){
    if(table==='job_matches'&&failInsert){failInsert=false;return {data:null,error:{message:'test write unavailable'}};}
    selected=[];for(const value of values){const keys=(opts.onConflict||'id').split(',');if(tables[table].some(r=>keys.every(k=>r[k]===value[k])))continue;const row={id:'row-'+(++id),attempts:0,...clone(value)};tables[table].push(row);selected.push(row);}
   }else if(action==='update'){selected.forEach(r=>Object.assign(r,clone(values)));}else if(action==='delete'){tables[table]=tables[table].filter(r=>!selected.includes(r));}
   return {data:clone(single?selected[0]||null:selected),error:null};
  }).then(resolve,reject);}};return b;
 }};
}
function row(overrides={}){return {job_seeker_id:'u1',job_source_id:'s1',job_url:'https://employer.test/finance',job_title:'Finance Officer',company_name:'Actual Employer',employer_name:'Actual Employer',job_description:'Short summary',job_description_status:'limited',location:'Johannesburg',match_score:85,is_custom_source:false,status:'pending',...overrides};}
(async()=>{
 let clock=1000000,calls=[];const browser={isConnected:()=>true,close:async()=>{}};
 let runtime=createBrowserRuntime({engine:()=>({launch:async opts=>{calls.push(opts);return browser;}}),logger:{log(){},warn(){}},now:()=>clock});
 const shared=await Promise.all([runtime.getShared(),runtime.getShared(),runtime.getShared()]);assert.equal(calls.length,1);assert.equal(calls[0].channel,'chromium');assert(shared.every(x=>x===browser));await runtime.close();
 calls=[];runtime=createBrowserRuntime({engine:()=>({launch:async opts=>{calls.push(opts);if(opts.channel)throw new Error('SIGTRAP');return browser;}}),logger:{log(){},warn(){}},now:()=>clock});await runtime.launch();assert.equal(calls.length,2);assert.equal(calls[1].channel,undefined);
 calls=[];runtime=createBrowserRuntime({engine:()=>({launch:async opts=>{calls.push(opts);throw new Error('SIGTRAP');}}),logger:{log(){},warn(){}},now:()=>clock});await assert.rejects(runtime.getShared(),/SIGTRAP/);await assert.rejects(runtime.getShared(),/cooling down/);assert.equal(calls.length,2);clock+=61000;await assert.rejects(runtime.getShared());assert.equal(calls.length,4);
 let db=database();const opts={now:()=>clock,fit,scope};
 const raw=row({api_key:'must-not-persist',resume_text:'private-profile'});await queue.deferCandidates(db,[raw],opts);await queue.deferCandidates(db,[raw],opts);assert.equal(db.tables.job_discovery_candidates.length,1);assert(!('api_key' in db.tables.job_discovery_candidates[0].payload));assert(!('resume_text' in db.tables.job_discovery_candidates[0].payload));
 clock+=300001;let result=await queue.processCandidates(db,{...opts,capture:async()=>({status:'unavailable',errorCode:'browser_unavailable'})});assert.equal(result.published,0);assert.equal(db.tables.job_matches.length,0);assert.equal(db.tables.job_discovery_candidates[0].attempts,1);assert.equal(db.tables.job_discovery_candidates[0].last_error,'browser_unavailable');
 clock+=300001;db.failNextInsert();result=await queue.processCandidates(db,{...opts,capture:async()=>complete});assert.equal(result.published,0);assert.equal(db.tables.job_discovery_candidates.length,1);assert.match(db.tables.job_discovery_candidates[0].last_error,/write unavailable/);
 clock+=600001;result=await queue.processCandidates(db,{...opts,capture:async()=>complete});assert.equal(result.published,1);assert.equal(db.tables.job_discovery_candidates.length,0);assert.equal(db.tables.job_matches[0].job_description,full);assert(details.canPublishJobDetails(db.tables.job_matches[0],'Finance Officer'));assert(!('_discovery_country' in db.tables.job_matches[0]));
 // A duplicate must not overwrite any applicant/admin decisions.
 db.tables.job_matches[0].status='applied';await queue.deferCandidates(db,[row()],opts);clock+=300001;await queue.processCandidates(db,{...opts,capture:async()=>complete});assert.equal(db.tables.job_matches.length,1);assert.equal(db.tables.job_matches[0].status,'applied');assert.equal(db.tables.job_discovery_candidates.length,0);
 // An empty signup must never be captured or published; completing the existing
 // fields enables the same preserved candidate without requiring a CV file.
 db=database();const completed=clone(db.tables.job_seekers[0]);db.tables.job_seekers[0]={id:'u1',full_name:'New Signup',status:'active',api_provider:'shared',auto_search_enabled:true,discovery_mode:'both'};
 await queue.deferCandidates(db,[row()],opts);clock+=300001;let blankCaptures=0;
 result=await queue.processCandidates(db,{...opts,capture:async()=>{blankCaptures++;return complete;}});
 assert.equal(blankCaptures,0);assert.equal(result.published,0);assert.equal(db.tables.job_matches.length,0);
 assert.match(db.tables.job_discovery_candidates[0].last_error,/profile requirements/);
 db.tables.job_seekers[0]=completed;clock+=300001;result=await queue.processCandidates(db,{...opts,capture:async()=>complete});assert.equal(result.published,1);
 for(const mode of ['disabled-account','disabled-feed','opted-out','blocked-employer','partial']){
  db=database();let value=row(),captures=0;if(mode==='disabled-account')db.tables.job_seekers[0].status='paused';if(mode==='disabled-feed')db.tables.user_job_sources=[];
  if(mode==='opted-out'){value=row({job_source_id:null,is_custom_source:true,job_custom_source_id:'w1'});db.tables.job_custom_sources=[{id:'w1',active:true}];db.tables.job_custom_source_optouts=[{job_seeker_id:'u1',job_custom_source_id:'w1'}];}
  if(mode==='blocked-employer'){db.tables.job_seekers[0].blocked_companies=['Actual Employer'];value=row({company_name:'Source',employer_name:null});}
  await queue.deferCandidates(db,[value],opts);clock+=300001;await queue.processCandidates(db,{...opts,capture:async()=>{captures++;return mode==='partial'?{description:'Rental Administrator',status:'limited',employer:'Actual Employer'}:complete;}});assert.equal(db.tables.job_matches.length,0,mode);assert.equal(db.tables.job_discovery_candidates.length,1,mode);if(['disabled-account','disabled-feed','opted-out'].includes(mode))assert.equal(captures,0,mode);
 }
 // A native ZA posting already accepted by discovery keeps its country evidence.
 db=database();await queue.deferCandidates(db,[row({location:null})],opts);clock+=300001;await queue.processCandidates(db,{...opts,capture:async()=>complete});assert.equal(db.tables.job_matches.length,1);
 // Existing in-flight drain is shared rather than overlapped by another timer.
 db=database();await queue.deferCandidates(db,[row()],opts);clock+=300001;let release;const wait=new Promise(r=>release=r);const first=queue.processCandidates(db,{...opts,capture:async()=>{await wait;return complete;}});const second=queue.processCandidates(db,opts);assert.equal(first,second);release();await first;assert.equal(db.tables.job_matches.length,1);
 // Bound distinct URLs per pass while preserving the unprocessed candidates.
 db=database();await queue.deferCandidates(db,[row(),row({job_url:'https://employer.test/second',job_title:'Office Clerk'})],opts);clock+=300001;result=await queue.processCandidates(db,{...opts,limit:1,capture:async()=>complete});assert.equal(result.retried,1);assert.equal(db.tables.job_discovery_candidates.length,1);
 console.log('PASS browser full-Chromium preference, fallback, cooldown and shared launch; durable retry, backoff, failed writes, complete-only publication, status preservation, account/feed/opt-out/block controls, country evidence, concurrency and bounded work');
})().catch(error=>{console.error(error);process.exitCode=1;});
