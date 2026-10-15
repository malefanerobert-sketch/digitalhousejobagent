'use strict';
// Prefer Playwright's full Chromium/new headless mode. The supplied Railway
// logs show the separately packaged headless shell dying with SIGTRAP.
function diagnostic(error){
 const text=String(error?.message||error||'Unknown browser error').replace(/https?:\/\/\S+/g,'[private URL]').replace(/\s+/g,' ');
 return (/SIGTRAP/.test(text)?'Chromium exited with SIGTRAP. ':'')+text.slice(0,350);
}
function createBrowserRuntime({engine=()=>require('playwright').chromium,logger=console,now=()=>Date.now(),cooldownMs=60000,executablePath=process.env.CHROMIUM_PATH}={}){
 let shared=null,launching=null,failedUntil=0,lastFailure='';
 async function launch(){
  if(now()<failedUntil)throw new Error('Browser startup cooling down: '+lastFailure);
  const attempts=executablePath?[{executablePath}]:[{channel:'chromium'},{}];
  for(const options of attempts){
   try{
    const browser=await engine().launch({headless:true,args:['--no-sandbox','--disable-dev-shm-usage'],...options});
    failedUntil=0;logger.log('[job-browser] Started '+(options.channel?'full Chromium':options.executablePath?'configured Chromium':'default Chromium'));return browser;
   }catch(error){lastFailure=diagnostic(error);logger.warn('[job-browser] Launch failed: '+lastFailure);}
  }
  failedUntil=now()+cooldownMs;
  throw new Error('No working Chromium runtime: '+lastFailure);
 }
 async function getShared(){
  if(shared&&shared.isConnected())return shared;
  if(launching)return launching;
  launching=launch().then(browser=>{shared=browser;return browser;}).finally(()=>{launching=null;});
  return launching;
 }
 async function close(){const browser=shared;shared=null;if(browser)await browser.close().catch(()=>{});}
 return {launch,getShared,close};
}
const runtime=createBrowserRuntime();
module.exports={createBrowserRuntime,launchJobBrowser:()=>runtime.launch(),getDetailsBrowser:()=>runtime.getShared(),closeDetailsBrowser:()=>runtime.close(),diagnostic};
