const fs=require('fs'),assert=require('node:assert/strict');
const {chromium}=require('/data/application-tests/node_modules/playwright');
(async()=>{
 const web=fs.readFileSync(__dirname+'/index.html','utf8');
 const b=await chromium.launch({headless:true,executablePath:'/usr/local/bin/chromium',args:['--no-sandbox']});const p=await b.newPage();
 try{
 await p.setContent('<div id="view-profile"><input id="pfName"><input type="checkbox" id="pfConfirmReal"><div id="profileReadiness"></div></div><div id="applicationReadinessCard"></div><div id="matchGrid"><button data-id="job" data-action="apply">Apply</button></div>');
 const rs=web.indexOf('let applicationReadiness=null;'),re=web.indexOf('/* ================= PROFILE ================= */',rs);
 const hs=web.indexOf("$('#matchGrid').addEventListener('click', async (e)=>"),he=web.indexOf('\n/* ================= APPLICATIONS',hs);
 await p.addScriptTag({content:`var currentSeeker={id:'applicant'};var $=s=>document.querySelector(s);var esc=s=>String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');var setView=v=>window.lastView=v;var matches=[{id:'job',status:'skipped'}];var applications=[];var openNotes=new Set();var renderMatches=()=>{};var renderDashboard=()=>{};var toast=x=>window.lastToast=x;var calls=[];var response={ready:false,status:'awaiting_applicant_information',missing:['Actual current city','Confirm real information']};var sb={rpc:async(n,args)=>{calls.push(n);if(n==='get_application_readiness')return {data:response,error:null};return {data:{},error:null}}};`+web.slice(rs,re)+web.slice(hs,he)});
 await p.evaluate(()=>refreshApplicationReadiness());assert((await p.locator('#profileReadiness').innerText()).includes('Actual current city'));
 await p.click('button[data-action=apply]');assert.equal(await p.evaluate(()=>calls.filter(x=>x==='request_job_application').length),0);assert.equal(await p.evaluate(()=>matches[0].status),'skipped');assert.equal(await p.evaluate(()=>lastView),'profile');
 await p.evaluate(()=>response={ready:true,missing:[]});await p.click('button[data-action=apply]');assert.equal(await p.evaluate(()=>calls.filter(x=>x==='request_job_application').length),1);assert.equal(await p.evaluate(()=>matches[0].status),'approved');
 await p.check('#pfConfirmReal');await p.fill('#pfName','Changed details');assert.equal(await p.isChecked('#pfConfirmReal'),false);
 await p.evaluate(()=>sb.rpc=async()=>({error:{message:'Unavailable'}}));assert.equal((await p.evaluate(()=>refreshApplicationReadiness())).ready,false);
 console.log('PASS checklist, incomplete queue blocking, complete queue path, reconfirmation on editing, and fail-closed readiness errors');
 }finally{await b.close()}
})().catch(e=>{console.error(e);process.exit(1)});
