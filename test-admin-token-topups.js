'use strict';
const fs=require('fs'),assert=require('assert/strict'),vm=require('vm');
const html=fs.readFileSync(__dirname+'/admin.html','utf8');
for(const m of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(m[1]);
const css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
const modal=html.slice(html.indexOf('<!-- Admin-only token top-up;'),html.indexOf('<!-- Apply-on-behalf modal:'));
const code=html.slice(html.indexOf('/* ================= ADMIN TOKEN TOPUPS'),html.indexOf('/* ================= JOB SOURCES'));
const setup=String.raw`
const $=s=>document.querySelector(s),esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const accounts=[{id:'account-a',full_name:'Robert Fixture',dedicated_email:'robert@example.test',status:'active'},{id:'account-b',full_name:'Second Account',dedicated_email:'second@example.test',status:'active'}];let userJobSources=[],jobSources=[];
let balances={'account-a':552,'account-b':600},receipts=new Map(),calls=[],control=null,readControl=null,confirmed=true;
window.confirm=()=>confirmed;function toast(text){window.lastToast=text;}
const check=(value,message)=>{if(!value)throw Error(message);};const tick=()=>new Promise(r=>setTimeout(r,0));
async function wait(predicate){for(let i=0;i<150;i++){if(predicate())return;await new Promise(r=>setTimeout(r,5));}throw Error('Timed out');}
function processTopup(p){
 if(receipts.has(p.p_request_id)){const r=receipts.get(p.p_request_id);return {data:{...r,balance:balances[p.p_job_seeker_id],already_processed:true}};}
 balances[p.p_job_seeker_id]+=p.p_amount;
 const r={job_seeker_id:p.p_job_seeker_id,request_id:p.p_request_id,amount:p.p_amount,balance:balances[p.p_job_seeker_id],receipt_id:'receipt-'+receipts.size,already_processed:false};receipts.set(p.p_request_id,r);return {data:r};
}
const sb={async rpc(name,p){calls.push({name,p:{...p}});if(name==='admin_get_application_credit_balance')return readControl?readControl(p):{data:{job_seeker_id:p.p_job_seeker_id,balance:balances[p.p_job_seeker_id],staff_id:'staff-fixture'}};if(name==='admin_top_up_application_credits')return control?control(p):processTopup(p);throw Error('Unexpected RPC');},from(){throw Error('Top-ups must use authorized RPCs, never direct writes');}};
`;
const tests=String.raw`
(async()=>{
 renderAccounts();check(document.querySelectorAll('[data-token-topup]').length===2,'Top-up action present on every account');
 $('#acctList [data-token-topup="account-a"]').click();await wait(()=>tokenTopupContext?.ready);check($('#tokenTopupName').textContent==='Robert Fixture'&&$('#tokenTopupBalance').textContent==='552 tokens','Selected account and actual balance');check(getComputedStyle($('#tokenTopupReload')).display==='none','Balance retry hidden when ready');
 for(const amount of ['0','-5','1.5','1000001']){$('#tokenTopupAmount').value=amount;$('#tokenTopupNote').value='Fixture credit';const before=calls.length;await submitTokenTopup();check(calls.length===before,'Invalid amount rejected');}
 $('#tokenTopupAmount').value='100';$('#tokenTopupNote').value='';const beforeNote=calls.length;await submitTokenTopup();check(calls.length===beforeNote,'Missing note rejected');
 $('#tokenTopupNote').value='Support credit';confirmed=false;await submitTokenTopup();check(balances['account-a']===552,'Confirmation cancellation makes no write');confirmed=true;
 let resolve;control=p=>new Promise(r=>resolve=()=>r(processTopup(p)));const a=submitTokenTopup();await submitTokenTopup();check(calls.filter(c=>c.name==='admin_top_up_application_credits').length===1,'Double-click makes one write');check($('#tokenTopupSave').disabled&&$('#tokenTopupAmount').readOnly&&$('#tokenTopupClose').disabled,'Form locked while writing');closeTokenTopup();check(!$('#tokenTopupModal').classList.contains('hidden'),'Cannot close an in-flight write');resolve();await a;control=null;
 check(balances['account-a']===652&&balances['account-b']===600,'Only selected balance increases');check($('#tokenTopupBalance').textContent==='652 tokens'&&$('#tokenTopupMessage').textContent.includes('Added 100 tokens'),'Confirmed new balance shown');check(!tokenTopupContext.pending&&!sessionStorage.getItem(tokenTopupContext.storageKey),'Completed pending key cleared');
 // Lost response after commit: close/reopen safely retries the same nonce and does not add again.
 $('#tokenTopupAmount').value='25';$('#tokenTopupNote').value='Lost response fixture';control=p=>{processTopup(p);throw Error('Connection lost');};await submitTokenTopup();check(balances['account-a']===677&&tokenTopupContext.pending,'Unknown result preserves request');const pending={...tokenTopupContext.pending};check($('#tokenTopupAmount').readOnly&&$('#tokenTopupSave').textContent==='Retry same top-up','Ambiguous retry cannot edit payload');closeTokenTopup();control=null;await openTokenTopup('account-a');check(tokenTopupContext.pending.p_request_id===pending.p_request_id,'Pending request survives closing and reopening');await submitTokenTopup();check(balances['account-a']===677&&$('#tokenTopupMessage').textContent.includes('already recorded'),'Retry returns existing receipt once');check(calls.at(-1).p.p_request_id===pending.p_request_id,'Retry keeps original nonce');
 $('#tokenTopupAmount').value='1';$('#tokenTopupNote').value='Permission test';control=async()=>({error:{code:'42501',message:'Admin access is required'}});await submitTokenTopup();check(!tokenTopupContext.pending&&!$('#tokenTopupAmount').readOnly&&$('#tokenTopupMessage').textContent.includes('Admin access'),'Explicit rejection leaves editable form and no credit');control=null;
 closeTokenTopup();let readResolve;readControl=()=>new Promise(r=>readResolve=r);const stale=openTokenTopup('account-a');readControl=null;await openTokenTopup('account-b');readResolve({data:{job_seeker_id:'account-a',balance:999,staff_id:'staff-fixture'}});await stale;check($('#tokenTopupName').textContent==='Second Account'&&$('#tokenTopupBalance').textContent==='600 tokens','Late response cannot cross accounts');
 closeTokenTopup();readControl=async()=>({error:{message:'Read unavailable'}});await openTokenTopup('account-a');check($('#tokenTopupSave').disabled&&!$('#tokenTopupReload').hidden,'Read failure blocks top-up and offers retry');readControl=null;$('#tokenTopupReload').click();await wait(()=>tokenTopupContext.ready);check($('#tokenTopupBalance').textContent==='677 tokens','Balance retry works');
 // The display never treats an unconfirmed payload as success.
 $('#tokenTopupAmount').value='2';$('#tokenTopupNote').value='Malformed response';control=async()=>({data:{job_seeker_id:'account-b',balance:999}});await submitTokenTopup();check(tokenTopupContext.pending&&$('#tokenTopupMessage').textContent.includes('not confirmed'),'Malformed response preserves safe retry');control=null;await submitTokenTopup();check(balances['account-a']===679,'Retry with same payload completes');
 closeTokenTopup();await openTokenTopup('account-a');check(!tokenTopupContext.pending,'Successful later top-up has no stale draft');
 check(document.documentElement.scrollWidth<=innerWidth,'No horizontal page overflow');const box=$('#tokenTopupModal .modal-card').getBoundingClientRect();check(box.left>=0&&box.right<=innerWidth,'Dialog fits viewport');
 const view=new URLSearchParams(location.search).get('view');if(['error','busy','success'].includes(view)){$('#tokenTopupAmount').value='50';$('#tokenTopupNote').value='Support credit';if(view==='error')control=async()=>{throw Error('Connection interrupted');};if(view==='busy')control=()=>new Promise(()=>{});const result=submitTokenTopup();if(view!=='busy')await result;}if(view==='overview')closeTokenTopup();
 const marker=document.createElement('pre');marker.id='test-result';marker.hidden=true;marker.textContent='PASS per-account action; actual balance; input validation; confirmation; single in-flight request; audited RPC only; lost-response retry nonce retained across reopen; rejected writes; stale responses; errors/retry; responsive dialog';document.body.append(marker);
})().catch(e=>{const marker=document.createElement('pre');marker.id='test-result';marker.textContent='FAIL '+e.message+' '+e.stack;document.body.append(marker);});
`;
fs.writeFileSync(__dirname+'/topup-fixture.html',`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main style="padding:24px 16px;max-width:1140px;margin:auto"><h2>Accounts</h2><input id="acctSearch" placeholder="Search accounts"><div class="card"><div id="acctList"></div></div></main>${modal}<script>${(setup+code+tests).replaceAll('</script','<\\/script')}</script>`);
(async()=>{for(const [width,view] of [[390,'form'],[1280,'form'],[320,'error'],[390,'busy'],[1280,'success'],[1280,'overview']]){
 const r=await require('./browserTestRunner').run({url:'file://'+__dirname+'/topup-fixture.html?view='+view,width,screenshot:__dirname+'/topup-'+view+'-'+width+'.png'});fs.writeFileSync(__dirname+'/topup-'+view+'-'+width+'.dom.html',r.dom);assert(r.marker?.startsWith('PASS'),r.marker||'No test marker');console.log(width+' '+view+' '+r.marker);
}})().catch(e=>{console.error(e);process.exitCode=1;});
