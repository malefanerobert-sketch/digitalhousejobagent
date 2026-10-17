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
 const dock=document.querySelector('#creditDock');let button=document.querySelector('[data-action="apply"]');
 check(!!button,'Approval control exists');check(dock.textContent.includes(mode==='zero'?'0 tokens':mode==='retry'?'599 tokens':'600 tokens'),'Server wallet balance rendered');
 check(button.textContent.trim()==='Approve','Approve button has no play icon or token label');check(!button.title.includes('token'),'No token wording in approval tooltip');check(dock.tagName==='DIV'&&!dock.hasAttribute('onclick')&&!dock.hasAttribute('tabindex')&&dock.getAttribute('role')!=='button','Indicator is display-only, not clickable');check(!dock.querySelector('small')&&!dock.textContent.includes('approval'),'No explanatory text on indicator');check(!document.querySelector('#creditModal')&&!document.body.innerText.includes('does not guarantee an application'),'Token pop-up and its entire statement removed');
 check(dock.closest('#sidebar')&&dock.parentElement.classList.contains('side-foot'),'Token card is in sidebar footer');
 check(dock===dock.parentElement.firstElementChild&&dock.nextElementSibling.classList.contains('agent-pill'),'Token card is immediately above On watch and Sign out');
 check(!!(document.querySelector('#sidebar [data-view="help"]').compareDocumentPosition(dock)&Node.DOCUMENT_POSITION_FOLLOWING),'Token card follows Contact us');
 check(!document.querySelector('#view-dashboard').contains(dock),'No token card in Dashboard content');
 if(innerWidth<=920)openDrawer();dock.scrollIntoView({block:'center'});await wait(300);
 const r=dock.getBoundingClientRect();check(r.left>=-1&&r.right<=innerWidth,'Sidebar token card fits viewport');
 check(getComputedStyle(dock).position==='relative','Indicator stays in sidebar flow, not floating');const balance=document.querySelector('#creditBalance'),br=balance.getBoundingClientRect(),gear=dock.querySelector('.credit-gear'),gr=gear.getBoundingClientRect(),bs=getComputedStyle(balance);check(bs.fontWeight==='400'&&bs.color==='rgb(52, 211, 153)'&&balance.tagName==='SPAN','Balance is green and non-bold');check(getComputedStyle(gear).position==='static'&&Math.abs(br.left-gr.right-6)<1,'Gear sits 6px from live balance');check(Math.abs((gr.left+br.right)/2-(r.left+r.width/2))<1,'Gear and live balance centered together');
 check(innerWidth===Number(params.get('viewportWidth')),'Exact target viewport');check(document.documentElement.scrollWidth<=document.documentElement.clientWidth,'No horizontal overflow');
 if(mode==='dashboard'){const out=document.createElement('pre');out.id='test-result';out.hidden=true;out.textContent='PASS Sidebar token placement below Contact us / above On watch '+innerWidth;document.body.append(out);return;}
 closeDrawer();setView('matches');button=document.querySelector('[data-action="apply"]');button.scrollIntoView({block:'center'});
 button.click();check(button.disabled&&button.textContent.includes('Submitting'),'Pending request locked');
 check(!document.querySelector('.token-burst'),'No charge animation before server success');
 button.dispatchEvent(new MouseEvent('click',{bubbles:true}));check(creditRpcCount===1,'Double-click sends only one request');
 await wait(240);if(mode==='snapshot')await wait(500);
 if(mode==='zero'||mode==='network'){
  check(!document.querySelector('.token-burst'),'Failed request produces no spend sparks');check(matches[0].status==='pending','Failed approval stays pending');check(!document.querySelector('[data-action="apply"]').disabled,'Approval can be retried');check(walletBalance===(mode==='zero'?0:600),'Failed request does not spend');check(document.querySelector('#toasts').textContent.includes(mode==='zero'?'0 tokens':'Network interrupted'),'Actionable error shown');
 }else{
  check(matches[0].status==='approved','Successful approval queued');check(document.querySelector('#creditBalance').textContent.includes('599'),'Authoritative remaining balance shown');
  if(mode==='retry'){check(!document.querySelector('.token-burst'),'Idempotent retry does not show a second charge');}
  else{
   const effect=document.querySelector('.token-burst');check(!!effect,'Firework sparks rendered');
   check(effect.textContent==='−1 token'&&!effect.querySelector('.token-submit-text')&&effect.querySelector('.token-spend-label')&&!effect.querySelector('b,em'),'Only small token phrase; no submitted phrase, emoji or flames');
   check(effect.querySelectorAll('i').length===20,'Two radial rings of small firework sparks');
   const style=getComputedStyle(effect),sparkStyle=getComputedStyle(effect.querySelector('i'));
   check(style.backgroundColor==='rgba(0, 0, 0, 0)'&&style.borderTopWidth==='0px'&&style.width==='0px','No visible badge, card or box');
   check(parseFloat(sparkStyle.width)===2&&parseFloat(sparkStyle.height)===5,'Compact spark particles rather than flame shapes');
   const label=effect.querySelector('.token-spend-label'),ls=getComputedStyle(label);check(ls.fontSize==='10px'&&ls.fontWeight==='400'&&ls.color==='rgb(255, 241, 191)'&&ls.backgroundColor==='rgba(0, 0, 0, 0)'&&ls.borderTopWidth==='0px'&&ls.padding==='0px','Small unboxed phrase');
   const center=el=>{const r=el.getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};};const tokenInitial=center(label);
   if(!params.has('reduced')){const r=label.getBoundingClientRect();check(r.left>=0&&r.right<=innerWidth,'Token phrase fits viewport');}
   if(!params.has('reduced'))check(ls.animationName==='token-spend-snap'&&ls.animationDuration==='2s','Token phrase finishes in two seconds');
   if(params.has('reduced'))check(style.display==='none','Reduced-motion preference respected');
   else check(sparkStyle.animationName==='token-firework-snap'&&sparkStyle.animationDuration==='2s','Two-second radial firework motion');
   if(mode!=='snapshot'){await wait(1000);check(!!document.querySelector('.token-burst'),'Sparks remain after one second');await wait(1300);check(!document.querySelector('.token-burst'),'Both animations cleaned up after two seconds');}

  }
 }
 if(mode!=='snapshot'){
  if(innerWidth<=920)openDrawer();dock.scrollIntoView({block:'center'});const wasOpen=document.querySelector('#sidebar').classList.contains('open');dock.click();await wait(10);check(document.querySelector('#sidebar').classList.contains('open')===wasOpen,'Click on display-only balance has no effect');check(!document.querySelector('.modal:not(.hidden)'),'No modal opens from token indicator');
 }
 const out=document.createElement('pre');out.id='test-result';out.hidden=true;out.textContent='PASS '+mode+' '+innerWidth+': server balance, plain Approve button, pending lock, no double charge, success/error/retry behavior, sparks and cleanup, compact display-only indicator, mobile layout';document.body.append(out);
})().catch(e=>{const out=document.createElement('pre');out.id='test-result';out.textContent='FAIL '+e.stack;document.body.append(out);});
`;
let fixture=input.replace(/<link[^>]+(?:href="https:|rel="preconnect")[^>]*>/g,'').replace(/<script src="https:[^>]+><\/script>/g,'');
fixture=fixture.replace('<script src="supportAccess.js?v=admin-approved-queue-v1"></script>',`<script>${setup.replaceAll('</script','<\\/script')}</script><script src="${site}/supportAccess.js"></script>`);
fixture=fixture.replace('</body>',`<script>${tests.replaceAll('</script','<\\/script')}</script></body>`);fs.writeFileSync(root+'/credits-fixture.html',fixture);
(async()=>{
for(const [mode,width,reduced] of [['dashboard',1280],['dashboard',390],['success',1280],['success',390],['success',320],['zero',390],['retry',390],['network',1280],['snapshot',390],['snapshot',1280],['snapshot',320],['snapshot',390,true],['success',390,true]]){
 if(process.env.CREDIT_PREVIEW_ONLY&&!['snapshot','dashboard'].includes(mode))continue;
 const label=mode+'-'+width+(reduced?'-reduced':'');
 const {marker,dom}=await require('./browserTestRunner').run({url:`file://${root}/credits-fixture.html?scenario=normal&creditMode=${mode}&viewportWidth=${width}${reduced?'&reduced=1':''}`,width,reduced,screenshot:root+'/credits-'+label+'.png'});
 fs.writeFileSync(root+'/credits-'+label+'.dom.html',dom);
 assert(marker?.startsWith('PASS'),marker||'Browser did not finish');console.log(marker);
}
})().catch(error=>{console.error(error);process.exitCode=1;});
