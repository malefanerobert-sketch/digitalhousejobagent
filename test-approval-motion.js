'use strict';
const fs=require('fs'),assert=require('assert/strict'),{run}=require('./browserTestRunner');
const html=fs.readFileSync(__dirname+'/index.html','utf8'),css=html.match(/<style>([\s\S]*?)<\/style>/)[1];
const fn=html.slice(html.indexOf('function showTokenSpark(rect){'),html.indexOf('\n/* ================= AUTH',html.indexOf('function showTokenSpark(rect){')));
const script=String.raw`
FN
showTokenSpark({left:innerWidth<921?46:350,top:350,width:78,height:30});
const effect=document.querySelector('.token-burst'),label=effect.querySelector('.token-spend-label'),spark=effect.querySelector('i'),animations=effect.getAnimations({subtree:true});
const sample=t=>{animations.forEach(a=>{a.pause();a.currentTime=t;});const sm=new DOMMatrixReadOnly(getComputedStyle(spark).transform),lm=new DOMMatrixReadOnly(getComputedStyle(label).transform);return {sparkX:sm.m41,labelY:lm.m42,labelX:lm.m41,labelOpacity:Number(getComputedStyle(label).opacity),sparkOpacity:Number(getComputedStyle(spark).opacity)};};
try{
 if(animations.length!==21||animations.some(a=>a.effect.getTiming().duration!==2000))throw Error('Both effects must be two seconds');
 if(getComputedStyle(spark).width!=='2px'||getComputedStyle(spark).height!=='5px'||parseFloat(spark.style.getPropertyValue('--dx'))!==52)throw Error('Compact particle size or spread missing');
 const initial=sample(0),early=sample(500),middle=sample(1000),end=sample(2000);
 if(early.sparkX<parseFloat(spark.style.getPropertyValue('--dx'))*.77)throw Error('Burst still too slow in first second');
 if(early.labelX<=initial.labelX)throw Error('Token phrase must move right');
 if(initial.labelY-early.labelY<18)throw Error('Token text still drifts too slowly');
 if(early.sparkX<(middle.sparkX-early.sparkX)*3)throw Error('No distinct initial burst');
 if(Math.abs(end.labelX-initial.labelX-57.6)>.1||Math.abs(end.labelY-initial.labelY+52.8)>.1)throw Error('Token flight must be exactly 40 percent shorter');
 if(end.labelOpacity!==0||end.sparkOpacity!==0)throw Error('Effects do not finish at two seconds');
 const particles=[...effect.querySelectorAll('i')];
 if(!particles.some(p=>parseFloat(p.style.getPropertyValue('--dy'))<0)||!particles.some(p=>parseFloat(p.style.getPropertyValue('--dy'))>0))throw Error('Restore the full round burst, including downward sparks');
 sample(0);const origin=label.getBoundingClientRect(),burstX=parseFloat(effect.style.left);if(Math.abs(origin.left+origin.width/2-burstX)>1)throw Error('Token must emerge from the spark center');
 for(const t of [100,400,500,1000,1500,1900,2000]){
  sample(t);particles.forEach(p=>{const m=new DOMMatrixReadOnly(getComputedStyle(p).transform),dx=parseFloat(p.style.getPropertyValue('--dx')),dy=parseFloat(p.style.getPropertyValue('--dy'));if(Math.abs(dx)>1&&Math.abs(dy)>1&&Math.abs(m.m41/dx-m.m42/dy)>.01)throw Error('Gravity bends a spark away from its radial path');if(t===2000&&Math.abs(m.m42-dy*1.12)>.1)throw Error('Extra falling motion at the end');});
 }
 sample(500);const r=label.getBoundingClientRect();if(r.left<0||r.right>innerWidth||r.top<0)throw Error('Token label leaves viewport');
 if(getComputedStyle(label).fontWeight!=='400'||label.textContent!=='−1 token')throw Error('Token styling changed');
 const out=document.createElement('pre');out.id='test-result';out.hidden=true;out.textContent='PASS motion: fast initial burst, faster text trajectory, both end at two seconds, round burst without falling tail, centered token moves right, text contained';document.body.append(out);
}catch(e){const out=document.createElement('pre');out.id='test-result';out.textContent='FAIL '+e.message;document.body.append(out);}
`.replace('FN',fn);
const markup=`<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style></head><body><main style="margin:24px 16px;max-width:360px"><h2>Discovered matches</h2><article class="mcard" style="margin-top:20px;min-height:410px"><div class="mcard-top"><span class="score">87% match</span><span class="pill green">⏳ Queued for an agent</span></div><h4>Finance Assistant</h4><div class="co">Actual Employer</div><div class="meta">📍 Johannesburg</div><p class="queue-request-message">Your request has been successfully submitted and is waiting for the agent on the next run.</p></article></main><script>${script}</script></body></html>`;
fs.writeFileSync(__dirname+'/motion-preview.html',markup);
(async()=>{for(const width of [320,390,1280]){const {marker}=await run({url:'file://'+__dirname+'/motion-preview.html',width});assert(marker?.startsWith('PASS'),marker||'No result');console.log(width,marker);}})().catch(e=>{console.error(e);process.exitCode=1;});
