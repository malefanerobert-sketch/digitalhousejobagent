'use strict';
const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const html=fs.readFileSync(__dirname+'/admin.html','utf8');
const code=html.slice(html.indexOf('let reportRows = [];'),html.indexOf('/* ================= APPLY-ON-BEHALF MODAL'));
const counts=JSON.parse(fs.readFileSync(__dirname+'/account-sized-fixtures.json','utf8'));
const elements={};for(const id of ['repList','repStats','repSearch','repFilter','repDateFilter','repAccounts','repAccountView','repAccountName','repAccountEmail','repLoadStatus'])elements['#'+id]={innerHTML:'',textContent:'',value:id==='repFilter'?'queue':id==='repDateFilter'?'all':'',focus(){},querySelectorAll(){return []},classList:{toggle(){}}};
const context={console,Date,Map,Intl,Number,String,Error,Set,$:s=>elements[s],esc:s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))};vm.createContext(context);vm.runInContext(code,context);
const evaluate=s=>vm.runInContext(s,context);const source=[];const now=new Date();const today=now.toISOString();const yesterday=new Date(+now-86400000).toISOString();
counts.forEach(([total,recent],i)=>{
 const account='account-'+i;
 for(let n=0;n<total;n++)source.push({id:account+'-'+(n<recent?'today-':'older-')+String(n).padStart(4,'0'),job_seeker_id:account,job_title:n<recent?'Today job '+n:'Older job '+n,status:i===counts.length-1&&n>=recent&&n<recent+4?'approved':'pending',discovered_at:n<recent?today:yesterday,job_seekers:{id:account,full_name:'Account '+(i+1),dedicated_email:account+'@example.test'},application_log:[]});
});
const requests=[];let cap=13,exact=true,earlyEmpty=false;
const mock={from:table=>{assert.equal(table,'job_matches');return {select:(fields,options)=>{assert.equal(options.count,'exact');let account=null;const q={is:()=>q,eq:(key,value)=>{assert.equal(key,'job_seeker_id');account=value;return q;},order:()=>q,range:async(a,b)=>{requests.push({account,offset:a,to:b});const rows=source.filter(r=>account===null||r.job_seeker_id===account).slice().sort((a,b)=>Date.parse(b.discovered_at)-Date.parse(a.discovered_at)||a.id.localeCompare(b.id));return {data:earlyEmpty&&a>0?[]:rows.slice(a,Math.min(b+1,a+cap)),count:exact?rows.length:null};}};return q;}};}};
context.sb=mock;context.initial=source.filter(r=>r.discovered_at===yesterday);evaluate('reportRows=initial.slice();renderReport();');
(async()=>{
 assert.equal(counts.length,47);
 for(let i=0;i<counts.length;i++){
  elements['#repDateFilter'].value='all';elements['#repSearch'].value='old lookup that must clear';
  const before=requests.length;await context.openReportAccount('account-'+i);
  const scoped=evaluate('reportRows.filter(r=>reportAccountKey(r)===reportAccountId)');
  assert.equal(scoped.length,counts[i][0],'All records loaded for account '+i);assert.equal(elements['#repSearch'].value,'');
  assert(requests.slice(before).every(q=>q.account==='account-'+i),'Every page must use the selected account ID');
  assert.equal((elements['#repList'].innerHTML.match(/data-apply-report=/g)||[]).length,counts[i][0]);
  assert(elements['#repList'].innerHTML.match(/data-apply-report="([^"]+)/)[1].includes('-today-'),'Newest jobs before older requests');
  elements['#repDateFilter'].value='today';context.renderReport();
  assert.equal((elements['#repList'].innerHTML.match(/data-apply-report=/g)||[]).length,counts[i][1],'All today jobs visible for account '+i);
 }
 console.log('PASS 47 account-sized fixtures: account-scoped fetches, full pagination with a 13-row server cap, fresh jobs not present in the cached overview, newest first and exact Today counts');
 // Later arrivals are fetched when reopening a card, rather than using its old snapshot.
 source.push({...source[0],id:'new-arrival',job_title:'Just arrived',discovered_at:today});await context.openReportAccount('account-0');assert(elements['#repList'].innerHTML.includes('Just arrived'));
 // Servers without an exact count are read until an empty page, not a short page.
 exact=false;elements['#repDateFilter'].value='all';await context.openReportAccount('account-1');assert.equal(evaluate('reportRows.filter(r=>reportAccountKey(r)===reportAccountId).length'),counts[1][0]);exact=true;
 // Missing pages must surface an error instead of replacing a complete cache.
 const original=evaluate('reportRows.filter(r=>reportAccountKey(r)===reportAccountId).length');earlyEmpty=true;await context.loadReport();assert.equal(evaluate('reportRows.filter(r=>reportAccountKey(r)===reportAccountId).length'),original);assert(elements['#repLoadStatus'].textContent.includes('only part of the queue'));earlyEmpty=false;
 // Switching accounts invalidates outstanding requests for a different account.
 let resolve=[];context.sb={from:()=>({select:()=>{const q={is:()=>q,eq:()=>q,order:()=>q,range:()=>new Promise(r=>resolve.push(r))};return q;}})};
 const a=context.openReportAccount('account-0'),b=context.openReportAccount('account-1');resolve[1]({data:[source.find(r=>r.job_seeker_id==='account-1')],count:1});await b;resolve[0]({data:[source[0]],count:1});await a;
 assert.equal(evaluate('reportAccountId'),'account-1');assert(!elements['#repList'].innerHTML.includes('Just arrived'));
 // SA midnight correctly includes 22:xx UTC in the following local day.
 assert.equal(context.reportLocalDay('2026-10-13T22:15:00Z'),'2026-10-14');
 console.log('PASS later arrivals, absent count headers, partial-response failure protection, account-switch race protection and Johannesburg midnight boundaries');
})().catch(e=>{console.error(e);process.exitCode=1;});
