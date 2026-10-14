'use strict';
// No service credentials or package dependencies. Runs the real queue code in
// local Chromium with fixtures; does not sign in, mutate data or apply to jobs.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process'),assert=require('node:assert/strict'),vm=require('node:vm');
const root=__dirname,html=fs.readFileSync(path.join(root,'admin.html'),'utf8');
for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
const queue=html.slice(html.indexOf('let reportRows = [];'),html.indexOf('/* ================= APPLY-ON-BEHALF MODAL'));
const delegates=html.slice(html.indexOf('// Delegate the Apply button clicks'),html.indexOf('/* ================= SUPPORT MESSAGES (admin side)'));
const css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
const section=html.slice(html.indexOf('<section id="tab-report"'),html.indexOf('<!-- JOB SOURCES -->')).replace('id="tab-report" class="hidden"','id="tab-report"');
const fixture=(id,account,name,title,status='pending',email=account+'@example.test')=>({id,job_seeker_id:account,job_title:title,status,job_url:'https://example.test/job/'+id,company_name:'Actual Employer',discovered_at:'2026-10-14T12:00:00Z',job_seekers:{id:account,full_name:name,dedicated_email:email},application_log:[]});
const base=[fixture('job-a','account-a','Joñes','Finance Assistant'),fixture('job-a2','account-a','Joñes','Office Clerk','approved'),fixture('job-a3','account-a','Joñes','Completed Finance Role','applied'),fixture('job-b','account-b','Joñes','Warehouse Controller','failed'),fixture('job-c','account-c','Lerato Mokoena','Receptionist'),{...fixture('job-d','account-d','','Missing Profile Job'),job_seekers:null},{...fixture('job-e','account-e','','Another Missing Profile Job'),job_seekers:null}];
const tests=String.raw`
(async()=>{
 const check=(condition,message)=>{if(!condition)throw Error(message);};
 window.actions=[];renderReport();
 check(document.querySelectorAll('[data-report-account]').length===5,'Account cards must group by ID, not duplicate display names');
 check(document.querySelector('#repList').innerHTML==='','No mixed jobs at account overview');
 check(document.querySelector('#repAccountView').classList.contains('hidden'),'Job view hidden initially');
 document.querySelector('[data-report-account="account-a"]').click();
 check(reportAccountId==='account-a','Account click selects stable ID');
 check(!document.querySelector('#repAccountView').classList.contains('hidden'),'Selected account jobs visible');
 check(document.querySelector('#repAccounts').classList.contains('hidden'),'Overview hidden while viewing one account');
 let list=document.querySelector('#repList');
 check(list.textContent.includes('Finance Assistant')&&list.textContent.includes('Office Clerk'),'Own open jobs shown');
 check(!list.textContent.includes('Warehouse Controller')&&!list.textContent.includes('Completed Finance Role'),'Other accounts and completed jobs excluded by default');
 check(document.querySelector('#repStats').textContent.includes('Saved discoveries: 3'),'Stats scoped to selected account');
 list.querySelector('[data-apply-report="job-a"]').click();check(actions.pop()==='apply:job-a','Apply action retains exact match ID');
 list.querySelector('[data-delete-report="job-a"]').click();check(actions.pop()==='delete:job-a','Delete action retains exact match ID');
 document.querySelector('#repFilter').value='applied';renderReport();check(list.textContent.includes('Completed Finance Role')&&!list.textContent.includes('Finance Assistant'),'Status filter stays in selected account');
 document.querySelector('#repFilter').value='queue';document.querySelector('#repSearch').value='warehouse';renderReport();check(list.textContent.includes('No jobs for this account'),'Search cannot cross into another account');
 document.querySelector('[data-report-back]').click();check(reportAccountId===null,'Back opens overview');check(document.querySelectorAll('[data-report-account]').length===1,'Overview respects search');
 check(document.querySelector('[data-report-account="account-b"]'),'Job search finds owning account');
 document.querySelector('#repSearch').value='';renderReport();openReportAccount('account-a');
 const pages=Array.from({length:301},(_,i)=>({...base[0],id:'page-'+i}));let ranges=[];
 window.sb={from:()=>({select:()=>{const q={is:()=>q,order:()=>q,range:async(a,b)=>{ranges.push([a,b]);return {data:pages.slice(a,b+1)};}};return q;}})};
 await loadReport();check(ranges.length===2&&reportRows.length===301,'Pagination loads all records');check(reportAccountId==='account-a','Refresh retains selected account');
 reportRows=base.map(x=>({...x}));renderReport();
 reportRows=reportRows.filter(x=>x.job_seeker_id!=='account-a');renderReport();check(list.textContent.includes('No jobs remain for this account'),'Last removal has a scoped empty state');check(!list.textContent.includes('Warehouse Controller'),'Empty account never falls back to mixed jobs');
 showReportAccounts();reportRows=[{...base[0],job_seekers:{id:'account-a',full_name:'<img src=x onerror="window.bad=1">',dedicated_email:'a@example.test'}}];renderReport();check(document.querySelectorAll('#repAccounts img').length===0&&!window.bad,'Account labels are safely escaped');
 document.querySelector('#repSearch').value='no-such-job';renderReport();check(document.querySelector('#repAccounts').textContent.includes('No accounts match'),'Empty filtered overview');
 document.querySelector('#repSearch').value='';reportRows=[];renderReport();check(document.querySelector('#repAccounts').textContent.includes('No application work is waiting'),'Empty queue');
 // A stale request must not overwrite the result of a newer refresh.
 let resolves=[];window.sb={from:()=>({select:()=>{const q={is:()=>q,order:()=>q,range:()=>new Promise(resolve=>resolves.push(resolve))};return q;}})};
 const older=loadReport(),newer=loadReport();resolves[1]({data:[base[2]]});await newer;resolves[0]({data:[base[3]]});await older;check(reportRows[0].id==='job-a3','Newer refresh wins');
 reportRows=base.map(x=>({...x}));renderReport();
 check(document.documentElement.scrollWidth<=innerWidth,'No horizontal overflow');
 const result=document.createElement('pre');result.id='test-result';result.textContent='PASS account cards; stable ID isolation; scoped search/status/stats; exact action IDs; pagination; refresh retention; empty states; escaping; stale refresh protection; responsive layout';result.hidden=true;document.body.append(result);
 if(new URLSearchParams(location.search).get('view')==='account')openReportAccount('account-a');
})().catch(error=>{const result=document.createElement('pre');result.id='test-result';result.textContent='FAIL '+error.message;document.body.append(result);});`;
const work=fs.mkdtempSync(path.join(os.tmpdir(),'admin-account-queue-'));
const browser=process.env.CHROMIUM_PATH||'/usr/local/bin/chromium';
const file=path.join(work,'fixture.html');
const js=`const $=s=>document.querySelector(s);function esc(s){return String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}var base=${JSON.stringify(base).replaceAll('<','\\u003c')};function openApplyOnBehalf(id){actions.push('apply:'+id);}function deleteAdminQueueMatch(id){actions.push('delete:'+id);}var sb;\n${queue}\n${delegates}\nreportRows=base.map(x=>({...x}));\n${tests}`;
fs.writeFileSync(file,`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin queue local regression</title><style>${css}</style><main style="max-width:1180px;margin:auto;padding:24px 16px">${section}</main><script>${js.replaceAll('</script','<\\/script')}</script>`);
for(const [width,height,view] of [[1280,900,'overview'],[390,844,'overview'],[1280,900,'account'],[390,844,'account']]){
 const screenshot=path.join(work,view+'-'+width+'.png');
 const result=cp.spawnSync(browser,['--headless','--no-sandbox','--disable-gpu','--hide-scrollbars','--no-proxy-server','--disable-background-networking','--allow-file-access-from-files','--virtual-time-budget=2000',`--window-size=${width},${height}`,`--screenshot=${screenshot}`,'--dump-dom','file://'+file+'?view='+view],{encoding:'utf8',timeout:30000,maxBuffer:5*1024*1024});
 fs.writeFileSync(path.join(work,view+'-'+width+'.dom.html'),result.stdout||'');
 const marker=(result.stdout||'').match(/<pre id="test-result"[^>]*>([^<]*)<\/pre>/)?.[1];
 assert(marker?.startsWith('PASS'),marker||result.error?.message||'Browser test did not finish');console.log(width+'px '+view+': '+marker);
}
console.log('Preview files:',work);
