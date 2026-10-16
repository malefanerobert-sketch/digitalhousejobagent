'use strict';
const fs=require('fs'),assert=require('assert/strict'),{run}=require('./browserTestRunner');
const html=fs.readFileSync('admin.html','utf8');
const css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
const funcs=html.slice(html.indexOf('const GROQ_SLOT_COUNT ='),html.indexOf('function showProviderKeyFields',html.indexOf('const GROQ_SLOT_COUNT =')));
const tests=String.raw`const $=s=>document.querySelector(s);const esc=s=>String(s).replaceAll('&','&amp;').replaceAll('"','&quot;');
FUNCS
renderGroqSlots([]);
requestAnimationFrame(()=>{try{
 const inputs=[...document.querySelectorAll('[data-groq-slot]')];if(inputs.length!==100)throw Error('Slot count');
 if(inputs.some(i=>i.type!=='password'))throw Error('Not masked');
 $('#groqKey99').value='fixture-only-last-key';if(readGroqSlots()[99]!=='fixture-only-last-key')throw Error('K100 save');
 $('#groqKey99').scrollIntoView({block:'center'});
 if(document.documentElement.scrollWidth>innerWidth+1)throw Error('Horizontal overflow: '+document.documentElement.scrollWidth+' > '+innerWidth);
 if($('#groqKey99').getBoundingClientRect().width<70)throw Error('K100 input too narrow');
 document.querySelector('#test-result').textContent='PASS all100, masked, K100 read, mobile fit';
 }catch(e){document.querySelector('#test-result').textContent='FAIL '+e.message;}});`.replace('FUNCS',funcs);
fs.writeFileSync('groq-layout.html',`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><main style="padding:16px;max-width:1050px;margin:auto"><div class="card"><h3>Shared AI keys — 100-slot Groq vault</h3><div id="groqKeyRows" class="row2"></div><p id="test-result"></p></div></main><script>${tests}</script>`);
(async()=>{for(const width of [320,390,1280]){const r=await run({url:'file://'+__dirname+'/groq-layout.html',width,screenshot:__dirname+'/groq-'+width+'.png'});console.log(width,r.marker);assert(r.marker?.startsWith('PASS'));}})().catch(e=>{console.error(e);process.exitCode=1;});
