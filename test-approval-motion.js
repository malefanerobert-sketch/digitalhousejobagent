'use strict';
const fs=require('fs'),assert=require('assert/strict'),{run}=require('./browserTestRunner');
const html=fs.readFileSync(__dirname+'/index.html','utf8'),css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
const fn=html.slice(html.indexOf('function showTokenSpark(rect){'),html.indexOf('\n/* ================= AUTH',html.indexOf('function showTokenSpark(rect){')));
const script=String.raw`
FN
showTokenSpark({left:innerWidth<921?46:350,top:350,width:78,height:30});
const effect=document.querySelector('.token-burst'),label=effect.querySelector('.token-spend-label'),spark=effect.querySelector('i'),animations=effect.getAnimations({subtree:true});
const sample=t=>{animations.forEach(a=>{a.pause();a.currentTime=t;});const sm=new DOMMatrixReadOnly(getComputedStyle(spark).transform),lm=new DOMMatrixReadOnly(getComputedStyle(label).transform);return {sparkX:sm.m41,labelY:lm.m42,labelOpacity:Number(getComputedStyle(label).opacity),sparkOpacity:Number(getComputedStyle(spark).opacity)};};
try{
 if(animations.length!==21||animations.some(a=>a.effect.getTiming().duration!==4000))throw Error('Both effects must be four seconds');
 const initial=sample(0),early=sample(1000),middle=sample(2000),end=sample(4000);
 if(early.sparkX<60)throw Error('Burst still too slow in first second');
 if(initial.labelY-early.labelY<35)throw Error('Token text still drifts too slowly');
 if(early.sparkX<(middle.sparkX-early.sparkX)*3)throw Error('No distinct initial burst');
 if(end.labelOpacity!==0||end.sparkOpacity!==0)throw Error('Effects do not finish at four seconds');
 sample(1000);const r=label.getBoundingClientRect();if(r.left<0||r.right>innerWidth||r.top<0)throw Error('Token label leaves viewport');
 if(getComputedStyle(label).fontWeight!=='400'||label.textContent!=='−1 token')throw Error('Token styling changed');
 const out=document.createElement('pre');out.id='test-result';out.hidden=true;out.textContent='PASS motion: fast initial burst, faster text trajectory, both end at four seconds, text contained';document.body.append(out);
}catch(e){const out=document.createElement('pre');out.id='test-result';out.textContent='FAIL '+e.message;document.body.append(out);}
`.replace('FN',fn);
const markup=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main style="margin:24px 16px;max-width:360px"><h2>Discovered matches</h2><article class="mcard" style="margin-top:20px;min-height:410px"><div class="mcard-top"><span class="score">87% match</span><span class="pill green">⏳ Queued for an agent</span></div><h4>Finance Assistant</h4><div class="co">Actual Employer</div><div class="meta">📍 Johannesburg</div><p class="queue-request-message">Your request has been successfully submitted and is waiting for the agent on the next run.</p></article></main><script>${script}</script></body></html>`;
fs.writeFileSync(__dirname+'/motion-preview.html',markup);
(async()=>{for(const width of [320,390,1280]){const {marker}=await run({url:'file://'+__dirname+'/motion-preview.html',width});assert(marker?.startsWith('PASS'),marker||'No result');console.log(width,marker);}})().catch(e=>{console.error(e);process.exitCode=1;});
