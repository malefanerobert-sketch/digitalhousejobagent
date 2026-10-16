'use strict';
// Local-file-only Chromium harness with explicit viewport metrics; no internet.
const fs=require('fs'),os=require('os'),path=require('path'),cp=require('child_process');
exports.run=async function({url,width,height=844,reduced=false,screenshot}){
 if(!url.startsWith('file://'))throw Error('Test runner only accepts local fixtures');
 const profile=fs.mkdtempSync(path.join(os.tmpdir(),'jobagent-browser-'));
 const child=cp.spawn(process.env.CHROMIUM_PATH||'/usr/local/bin/chromium',['--headless','--no-sandbox','--disable-gpu','--disable-dev-shm-usage','--no-proxy-server','--disable-background-networking','--allow-file-access-from-files','--remote-debugging-port=0','--user-data-dir='+profile,'about:blank'],{stdio:['ignore','ignore','pipe']});
 let ws;
 try{
  const endpoint=await new Promise((resolve,reject)=>{let log='';const timer=setTimeout(()=>reject(Error('Browser startup timed out')),10000);child.stderr.on('data',chunk=>{log+=chunk;const m=log.match(/DevTools listening on (ws:\/\/[^\s]+)/);if(m){clearTimeout(timer);resolve(m[1]);}});child.once('exit',()=>{clearTimeout(timer);reject(Error('Browser exited: '+log.slice(-600)));});});
  ws=new WebSocket(endpoint);await new Promise((resolve,reject)=>{ws.addEventListener('open',resolve,{once:true});ws.addEventListener('error',reject,{once:true});});
  let id=0;const pending=new Map();ws.addEventListener('message',event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);}});
  const call=(method,params={},sessionId)=>new Promise((resolve,reject)=>{const n=++id;pending.set(n,{resolve,reject});ws.send(JSON.stringify({id:n,method,params,...(sessionId?{sessionId}:{})}));});
  const {targetId}=await call('Target.createTarget',{url:'about:blank'}),{sessionId}=await call('Target.attachToTarget',{targetId,flatten:true});
  const page=(method,params)=>call(method,params,sessionId);
  await page('Page.enable');await page('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:width<921});
  if(reduced)await page('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
  await page('Page.navigate',{url});
  let marker;for(let i=0;i<200;i++){const result=await page('Runtime.evaluate',{expression:'document.querySelector("#test-result")?.textContent',returnByValue:true});marker=result.result?.value;if(marker)break;await new Promise(r=>setTimeout(r,50));}
  const dom=await page('Runtime.evaluate',{expression:'document.documentElement.outerHTML',returnByValue:true});
  if(screenshot){const image=await page('Page.captureScreenshot',{format:'png'});fs.writeFileSync(screenshot,Buffer.from(image.data,'base64'));}
  return {marker,dom:dom.result?.value||''};
 }finally{ws?.close();child.kill('SIGTERM');await new Promise(resolve=>{child.once('exit',resolve);setTimeout(resolve,1500);});fs.rmSync(profile,{recursive:true,force:true});}
};
