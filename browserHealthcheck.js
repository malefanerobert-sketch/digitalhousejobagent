'use strict';
const {launchJobBrowser}=require('./jobBrowser');
(async()=>{
 let browser;
 try{
  browser=await launchJobBrowser();const page=await browser.newPage();
  await page.setContent('<p id="ready">browser-ready</p>');
  if(await page.locator('#ready').textContent()!=='browser-ready')throw new Error('Chromium page execution failed');
  console.log('[browser-healthcheck] PASS: Chromium launched and rendered a local page');
 }finally{if(browser)await browser.close().catch(()=>{});}
})().catch(error=>{console.error('[browser-healthcheck] FAILED: '+error.message);process.exitCode=1;});
