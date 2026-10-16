'use strict';
const fs=require('fs'),cp=require('child_process'),assert=require('assert/strict');
const root=__dirname,site=process.env.PUBLIC_SITE_DIR||root;
const input=fs.readFileSync(site+'/index.html','utf8'),old=fs.readFileSync(root+'/test-staff-support.js','utf8');
let setup=old.slice(old.indexOf('const setup=String.raw`')+'const setup=String.raw`'.length,old.indexOf('`;\nconst tests=String.raw`'));
// Reuse the real-app regression transport but provide an authoritative credit endpoint.
setup+=String.raw`
window.creditRpcCount=0;window.walletBalance=600;
tables.application_credit_wallets=[{user_id:ownerId,balance:600}];
fake.rpc=async(name,args)=>{
 if(name!=='request_job_application')return {data:null,error:{message:'Unexpected RPC'}};
 window.creditRpcCount++;await new Promise(r=>setTimeout(r,180));
 const mode=params.get('creditMode');
 if(mode==='network')throw Error('Network interrupted. Refresh before retrying.');
 if(mode==='zero')return {data:null,error:{message:'You have 0 tokens. You need 1 token to approve a job.'}};
 const charged=mode!=='retry';if(charged){walletBalance--;tables.application_credit_wallets[0].balance=walletBalance;}
 return {data:{id:args.p_match_id,status:'approved',credit_balance:walletBalance,charged,tokens_used:charged?1:0},error:null};
};
if(params.get('creditMode')==='zero'){walletBalance=0;tables.application_credit_wallets[0].balance=0;}
if(params.get('creditMode')==='retry'){walletBalance=599;tables.application_credit_wallets[0].balance=599;}
`;
const tests=String.raw`
(async()=>{
 const check=(v,m)=>{if(!v)throw Error(m);},wait=ms=>new Promise(r=>setTimeout(r,ms)),mode=params.get('creditMode');
 for(let i=0;i<60&&!document.querySelector('[data-action="apply"]');i++)await wait(5);
 await loadCredits();setView('matches');
 const dock=document.querySelector('#creditDock'),button=document.querySelector('[data-action="apply"]');
 check(!!button,'Approval control exists');check(dock.textContent.includes(mode==='zero'?'0 tokens':mode==='retry'?'599 tokens':'600 tokens'),'Server wallet balance rendered');
 check(button.textContent.includes('1 token'),'Approval price is disclosed');
 const r=dock.getBoundingClientRect();check(r.left>=0&&r.right<=innerWidth&&r.bottom<=innerHeight,'Credit indicator fits viewport');
 if(innerWidth<=920)check(r.bottom<document.querySelector('#bottomTabs').getBoundingClientRect().top,'Credit card sits above navigation');
 check(innerWidth===Number(params.get('viewportWidth')),'Exact target viewport');check(document.documentElement.scrollWidth<=document.documentElement.clientWidth,'No horizontal overflow');
 button.click();check(button.disabled&&button.textContent.includes('Submitting'),'Pending request locked');
 check(!document.querySelector('.token-burst'),'No charge animation before server success');
 button.dispatchEvent(new MouseEvent('click',{bubbles:true}));check(creditRpcCount===1,'Double-click sends only one request');
 await wait(240);
 if(mode==='zero'||mode==='network'){
  check(!document.querySelector('.token-burst'),'Failed request produces no spend sparks');check(matches[0].status==='pending','Failed approval stays pending');check(!document.querySelector('[data-action="apply"]').disabled,'Approval can be retried');check(walletBalance===(mode==='zero'?0:600),'Failed request does not spend');check(document.querySelector('#toasts').textContent.includes(mode==='zero'?'0 tokens':'Network interrupted'),'Actionable error shown');
 }else{
  check(matches[0].status==='approved','Successful approval queued');check(document.querySelector('#creditBalance').textContent.includes('599'),'Authoritative remaining balance shown');
  if(mode==='retry'){check(!document.querySelector('.token-burst'),'Idempotent retry does not show a second charge');}
  else{
   check(document.querySelector('.token-burst b')?.textContent==='🔥 −1 token used','Fire-spark debit label rendered');check(document.querySelectorAll('.token-burst i').length===10,'Small spark particles rendered');
   if(params.has('reduced'))check(getComputedStyle(document.querySelector('.token-burst i')).display==='none','Reduced-motion preference respected');
   if(mode!=='snapshot'){await wait(1150);check(!document.querySelector('.token-burst'),'Animation removed after about one second');}
  }
 }
 if(mode!=='snapshot'){
  dock.click();await wait(10);check(!document.querySelector('#creditModal').classList.contains('hidden'),'Token card opens balance details');check(document.querySelector('#creditModal').textContent.includes('600 free tokens')&&document.querySelector('#creditModal').textContent.includes('not available yet'),'Welcome grant and no payments yet explained');closeModal('creditModal');
 }
 const out=document.createElement('pre');out.id='test-result';out.hidden=true;out.textContent='PASS '+mode+' '+innerWidth+': server balance, price, pending lock, no double charge, success/error/retry behavior, sparks and cleanup, token details, mobile layout';document.body.append(out);
})().catch(e=>{const out=document.createElement('pre');out.id='test-result';out.textContent='FAIL '+e.stack;document.body.append(out);});
`;
let fixture=input.replace(/<link[^>]+(?:href="https:|rel="preconnect")[^>]*>/g,'').replace(/<script src="https:[^>]+><\/script>/g,'');
fixture=fixture.replace('<script src="supportAccess.js?v=application-credits-v1"></script>',`<script>${setup.replaceAll('</script','<\\/script')}</script><script src="${site}/supportAccess.js"></script>`);
fixture=fixture.replace('</body>',`<script>${tests.replaceAll('</script','<\\/script')}</script></body>`);fs.writeFileSync(root+'/credits-fixture.html',fixture);
(async()=>{
for(const [mode,width,reduced] of [['success',1280],['success',390],['success',320],['zero',390],['retry',390],['network',1280],['snapshot',390],['snapshot',1280],['success',390,true]]){
 const label=mode+'-'+width+(reduced?'-reduced':'');
 const {marker,dom}=await require('./browserTestRunner').run({url:`file://${root}/credits-fixture.html?scenario=normal&creditMode=${mode}&viewportWidth=${width}${reduced?'&reduced=1':''}`,width,reduced,screenshot:root+'/credits-'+label+'.png'});
 fs.writeFileSync(root+'/credits-'+label+'.dom.html',dom);
 assert(marker?.startsWith('PASS'),marker||'Browser did not finish');console.log(marker);
}
})().catch(error=>{console.error(error);process.exitCode=1;});
