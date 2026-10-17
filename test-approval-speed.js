'use strict';
const fs=require('fs'),assert=require('assert/strict'),{run}=require('./browserTestRunner');
const root=__dirname,site=process.env.PUBLIC_SITE_DIR||root,source=fs.readFileSync(site+'/index.html','utf8'),transport=fs.readFileSync(root+'/test-staff-support.js','utf8');
let setup=transport.slice(transport.indexOf('const setup=String.raw`')+'const setup=String.raw`'.length,transport.indexOf('`;\nconst tests=String.raw`'));
setup+=String.raw`
window.approvalRpcCalls=0;
fake.rpc=async(name,args)=>{if(name!=='request_job_application')throw Error('Unexpected RPC');approvalRpcCalls++;await new Promise(r=>setTimeout(r,120));tables.application_credit_wallets[0].balance=599;return {data:{id:args.p_match_id,status:'approved',credit_balance:599,charged:true,tokens_used:1},error:null};};
`;
const tests=String.raw`
(async()=>{
 const check=(c,m)=>{if(!c)throw Error(m);},wait=ms=>new Promise(r=>setTimeout(r,ms));
 for(let i=0;i<100&&!document.querySelector('[data-action="apply"]');i++)await wait(10);
 stopMatchLiveRefresh();const base={...matches[0]};matches=Array.from({length:850},(_,i)=>({...base,id:'fixture-'+i,job_title:'Finance Assistant '+i,discovered_at:new Date(Date.now()-i*1000).toISOString()}));setView('matches');await loadCredits();
 const button=document.querySelector('[data-action="apply"]'),other=document.querySelectorAll('#matchGrid > .mcard')[1];other.querySelector('[data-action="view"]').focus();
 let renderCalls=0,renderMs=0;const fullRender=renderMatches;renderMatches=(...args)=>{renderCalls++;const start=performance.now();const result=fullRender(...args);renderMs+=performance.now()-start;return result;};
 const walletReads=()=>calls.filter(c=>c.table==='application_credit_wallets').length,beforeReads=walletReads(),start=performance.now();button.click();check(button.disabled,'Button locked immediately');check(!document.querySelector('.token-burst'),'No sparks before server confirmation');check(matches[0].status==='pending','No optimistic success');
 for(let i=0;i<200&&matches[0].status!=='approved';i++)await wait(10);await wait(20);
 const result={width:innerWidth,matches:matches.length,renderCalls,renderMs:Math.round(renderMs),clickToConfirmedMs:Math.round(performance.now()-start),extraWalletReads:walletReads()-beforeReads,unrelatedCardPreserved:other.isConnected};
 check(approvalRpcCalls===1,'Only one approval RPC');check(matches[0].status==='approved','Confirmed state');check(document.querySelector('#creditBalance').textContent==='599 tokens','Confirmed balance');check(document.querySelector('.queue-request-message'),'Queued message');
 if(!params.has('baseline')){check(renderCalls===0,'No full-list rebuild on approval');check(other.isConnected,'Unrelated card preserved');check(document.activeElement===other.querySelector('[data-action="view"]'),'Unrelated focus preserved');check(result.extraWalletReads===0,'No redundant wallet read');check(document.documentElement.scrollWidth<=innerWidth,'No horizontal overflow');}
 const out=document.createElement('pre');out.id='test-result';out.hidden=true;out.textContent='PASS '+JSON.stringify(result);document.body.append(out);
})().catch(e=>{const out=document.createElement('pre');out.id='test-result';out.textContent='FAIL '+e.message;document.body.append(out);});
`;
let html=source.replace(/<link[^>]+(?:href="https:|rel="preconnect")[^>]*>/g,'').replace(/<script src="https:[^>]+><\/script>/g,'');
html=html.replace(/<script src="supportAccess.js\?v=[^"]+"><\/script>/,`<script>${setup.replaceAll('</script','<\\/script')}</script><script src="${site}/supportAccess.js"></script>`).replace('</body>',`<script>${tests.replaceAll('</script','<\\/script')}</script></body>`);
fs.writeFileSync(root+'/speed-fixture.html',html);
(async()=>{for(const width of [1280,390]){const {marker}=await run({url:`file://${root}/speed-fixture.html?scenario=normal${process.env.BASELINE?'&baseline=1':''}`,width});assert(marker?.startsWith('PASS'),marker||'No result');console.log(marker);}})().catch(e=>{console.error(e);process.exitCode=1;});
