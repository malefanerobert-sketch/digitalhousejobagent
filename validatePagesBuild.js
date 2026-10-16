'use strict';
// Validate the actual deployment artifact, not just the repository working tree.
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function validate(directory){
 const root=path.resolve(directory),allowed=new Set(['index.html','admin.html','supportAccess.js','.nojekyll','build.json']);
 for(const name of allowed)if(!fs.statSync(path.join(root,name),{throwIfNoEntry:false})?.isFile())throw new Error('Missing public asset: '+name);
 for(const name of fs.readdirSync(root))if(!allowed.has(name))throw new Error('Unexpected file in public artifact: '+name);
 for(const name of ['index.html','admin.html']){
  const html=fs.readFileSync(path.join(root,name),'utf8');
  if(!html.includes('name="jobagent-build" content="application-credits-v3"'))throw new Error('Stale HTML build: '+name);
  for(const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)){
   if(/^(?:https?:)?\/\//.test(match[1]))continue;
   const asset=decodeURIComponent(match[1].split(/[?#]/)[0]),resolved=path.resolve(root,asset);
   if(!resolved.startsWith(root+path.sep)||!fs.statSync(resolved,{throwIfNoEntry:false})?.isFile())throw new Error('Missing local script for '+name+': '+asset);
  }
  for(const match of html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/g))new vm.Script(match[1]);
 }
 const index=fs.readFileSync(path.join(root,'index.html'),'utf8'),admin=fs.readFileSync(path.join(root,'admin.html'),'utf8');
 if(!index.includes('id="creditDock"')||!index.includes('data.credit_balance')||!index.includes('data.charged===true&&data.tokens_used===1'))throw new Error('Missing server-confirmed credit UI');
 if(!index.includes('supportAccess.js?v=application-credits-v3'))throw new Error('Support helper is not versioned');
 if(!admin.includes("sb.rpc('admin_queue_account_summaries'")||!admin.includes('REPORT_LIST_SELECT'))throw new Error('Legacy admin queue in deployment artifact');
 new vm.Script(fs.readFileSync(path.join(root,'supportAccess.js'),'utf8'));
 const build=JSON.parse(fs.readFileSync(path.join(root,'build.json'),'utf8'));
 if(process.env.EXPECTED_PAGES_SHA&&build.commit!==process.env.EXPECTED_PAGES_SHA)throw new Error('Published manifest is not the requested commit');
 if(build.version!=='application-credits-v3'||!build.commit)throw new Error('Invalid build manifest');
 return 'PASS public artifact contains matched frontend builds, required support helper, lightweight queue and no extra worker files';
}
if(require.main===module){try{console.log(validate(process.argv[2]||'_site'));}catch(error){console.error(error.message);process.exitCode=1;}}
module.exports={validate};
