'use strict';
const fs=require('fs'),assert=require('assert/strict'),{run}=require('./browserTestRunner');
const root=__dirname,html=fs.readFileSync(root+'/index.html','utf8'),old=fs.readFileSync(root+'/test-staff-support.js','utf8');
let setup=old.slice(old.indexOf('const setup=String.raw`')+'const setup=String.raw`'.length,old.indexOf('`;\nconst tests=String.raw`'));
setup+=String.raw`
window.pendingApprovals=new Map();window.approvalRequests=0;
fake.rpc=(name,args)=>{if(name!=='request_job_application')throw Error('Unexpected RPC');approvalRequests++;return new Promise(resolve=>pendingApprovals.set(args.p_match_id,resolve));};
`;
const tests=String.raw`
(async()=>{
 const check=(v,m)=>{if(!v)throw Error(m);},wait=ms=>new Promise(r=>setTimeout(r,ms)),mode=params.get('mode');
 for(let i=0;i<100&&!document.querySelector('[data-action="apply"]');i++)await wait(10);
 stopMatchLiveRefresh();const base={...matches[0]};matches=Array.from({length:4},(_,i)=>({...base,id:'job-'+i}));if(mode==='skipped')matches[0].status='skipped';setView(mode==='skipped'?'skipped':'matches');await loadCredits();
 const button=id=>document.querySelector('[data-action="apply"][data-id="job-'+id+'"]'),reads=()=>calls.filter(c=>c.table==='application_credit_wallets').length;
 const confirmed=(id,balance)=>({data:{id:'job-'+id,status:'approved',credit_balance:balance,charged:true,tokens_used:1},error:null});
 const baseReads=reads();let refreshAborted=false;matchRefreshController={abort:()=>{refreshAborted=true;}};button(0).click();check(refreshAborted,'In-flight background fetch aborted before approval');matchRefreshController=null;check(approvalInFlight.size===1&&button(0).disabled,'Lock held while server pending');const matchReads=calls.filter(c=>c.table==='job_matches').length;await refreshLiveMatchLists();check(calls.filter(c=>c.table==='job_matches').length===matchReads,'Background refresh defers while approval pending');
 if(mode==='concurrent'){
  button(1).click();check(approvalRequests===2,'Two distinct requests');tables.application_credit_wallets[0].balance=598;
  pendingApprovals.get('job-1')(confirmed(1,598));await wait(10);check(reads()===baseReads,'No read before all requests settled');check(approvalInFlight.size===1,'First request still pending');
  pendingApprovals.get('job-0')(confirmed(0,599));await wait(10);check(reads()===baseReads+1,'Exactly one final reconciliation');check(creditBalance===598,'Out-of-order responses reconcile to current server balance');check(matches.slice(0,2).every(m=>m.status==='approved'),'Both queued');
 }else if(mode==='error'){
  const realFrom=fake.from;let finishWallet;fake.from=table=>{if(table!=='application_credit_wallets')return realFrom(table);calls.push({table});const q={select:()=>q,eq:()=>q,maybeSingle:()=>new Promise(resolve=>finishWallet=resolve)};return q;};
  pendingApprovals.get('job-0')({data:null,error:{message:'Connection error'}});await wait(10);check(button(0)&&!button(0).disabled,'Retry enabled before balance refresh finishes');check(matches[0].status==='pending'&&!document.querySelector('.token-burst'),'Error cannot show success or charge');check(typeof finishWallet==='function','Background balance read started');finishWallet({data:{balance:600},error:null});await wait(10);check(creditBalance===600,'Error reconciliation completed');
 }else if(mode==='missing-balance'){
  tables.application_credit_wallets[0].balance=599;const result=confirmed(0,599);delete result.data.credit_balance;pendingApprovals.get('job-0')(result);await wait(10);check(matches[0].status==='approved'&&creditBalance===599,'Legacy response queues and refreshes balance');check(reads()===baseReads+1,'Legacy balance read once');
 }else if(mode==='skipped'){
  tables.application_credit_wallets[0].balance=599;pendingApprovals.get('job-0')(confirmed(0,599));await wait(10);check(matches[0].agent_skipped_at&&isSkippedMatch(matches[0]),'Skipped history preserved');check(document.querySelector('.queue-request-message')&&document.querySelector('[data-match-card="job-0"]'),'Queued skipped card remains in skipped view');check(reads()===baseReads,'No redundant read');
 }else if(mode==='session-change'){
  currentUser=null;currentSeeker=null;resetCredits();pendingApprovals.get('job-0')(confirmed(0,599));await wait(10);check(creditBalance===null&&approvalInFlight.size===0,'Old response cannot mutate new session');check(!document.querySelector('.token-burst'),'No old-session charge animation');
 }else if(mode==='last-token'){
  button(1).click();tables.application_credit_wallets[0].balance=0;pendingApprovals.get('job-0')(confirmed(0,0));await wait(10);pendingApprovals.get('job-1')({data:null,error:{message:'You have 0 tokens'}});await wait(10);check(matches[0].status==='approved'&&matches[1].status==='pending','Only confirmed approval queued');check(creditBalance===0&&button(1)&&!button(1).disabled,'Zero balance current and denied request unlocked');check(reads()===baseReads+1,'One reconciliation after mixed success/error');
 }
 const out=document.createElement('pre');out.id='test-result';out.hidden=true;out.textContent='PASS '+mode+': confirmed updates, no double charges, scoped response and one-card refresh';document.body.append(out);
})().catch(e=>{const out=document.createElement('pre');out.id='test-result';out.textContent='FAIL '+e.message;document.body.append(out);});
`;
let fixture=html.replace(/<link[^>]+(?:href="https:|rel="preconnect")[^>]*>/g,'').replace(/<script src="https:[^>]+><\/script>/g,'');fixture=fixture.replace(/<script src="supportAccess.js\?v=[^"]+"><\/script>/,`<script>${setup.replaceAll('</script','<\\/script')}</script><script src="${root}/supportAccess.js"></script>`).replace('</body>',`<script>${tests.replaceAll('</script','<\\/script')}</script></body>`);fs.writeFileSync(root+'/concurrency-fixture.html',fixture);
(async()=>{for(const mode of ['concurrent','error','missing-balance','skipped','session-change','last-token']){const {marker}=await run({url:`file://${root}/concurrency-fixture.html?scenario=normal&mode=${mode}`,width:390});assert(marker?.startsWith('PASS'),marker||'No test result');console.log(marker);}})().catch(e=>{console.error(e);process.exitCode=1;});
