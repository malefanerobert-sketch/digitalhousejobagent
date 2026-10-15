require('dotenv').config();
const cron = require('node-cron');
// Two discovery paths run alongside each other, both South-Africa focused:
// discoverWatched.js handles Watched pages (SA company / job-board pages a
// user explicitly adds), and discoverAuto.js runs autonomous Adzuna ZA /
// RemoteOK / Jobmail search. So the Agent gets both: pages users add, and
// jobs it finds on its own.
const discoverWatched = require('./discoverWatched');
const discoverAuto = require('./discoverAuto');
const jobDetails = require('./jobDetails');
const sb = require('./supabaseClient');
const aiMatch = require('./aiMatch');
const candidateQueue=require('./candidateQueue');
const running=new Set();
async function guarded(name,task){
 if(running.has(name)){console.log('[scheduler] '+name+' is still running; skipped overlapping run');return;}
 running.add(name);try{return await task();}finally{running.delete(name);}
}
async function retryCandidates(){
 await aiMatch.loadSettings(sb);if(!aiMatch.isAgentEnabled())return;
 await candidateQueue.processCandidates(sb,{limit:8});
}
// Applications are performed by admins in admin.html. Never load the submitter here.

const WATCH_CRON = process.env.WATCH_CRON || '0 */3 * * *';     // watched pages — every 3 hours by default
const DISCOVER_CRON = process.env.DISCOVER_CRON || '0 */3 * * *'; // autonomous Adzuna/RemoteOK/Jobmail search — every 3 hours by default
const DETAILS_CRON = process.env.DETAILS_CRON || '*/15 * * * *';
// Bounded repair remains subject to the master switch, but not new-job volume.
async function repairJobDetails(){
  // Current scope is future jobs only. Historical repair requires explicit opt-in.
  if(process.env.REPAIR_EXISTING_JOB_DETAILS!=='true')return;
  await aiMatch.loadSettings(sb);
  if(!aiMatch.isAgentEnabled())return;
  await jobDetails.refreshSavedDescriptions(sb,{limit:8});
}
// No application cron: discovery-only deployment.

console.log('=================================================');
console.log(' Dispatch Agent Worker — starting up');
console.log(' watched-pages schedule:  ', WATCH_CRON);
console.log(' autonomous-search sched.:', DISCOVER_CRON);
console.log(' historical job-details repair:', process.env.REPAIR_EXISTING_JOB_DETAILS==='true'?DETAILS_CRON:'OFF (future jobs only)');
console.log(' discovery country: South Africa only — nationwide; US/global company feeds frozen');
console.log(' application mode: admin only — automatic submissions disabled');
console.log('=================================================');

// Run once immediately on startup so you see activity right away,
// then settle into the scheduled cadence.
guarded('discoverWatched',()=>discoverWatched.run()).catch(err => console.error('[startup discoverWatched]', err));
guarded('discoverAuto',()=>discoverAuto.run()).catch(err => console.error('[startup discoverAuto]', err));

cron.schedule(WATCH_CRON, () => {
  guarded('discoverWatched',()=>discoverWatched.run()).catch(err => console.error('[scheduled discoverWatched]', err));
});

cron.schedule(DISCOVER_CRON, () => {
  guarded('discoverAuto',()=>discoverAuto.run()).catch(err => console.error('[scheduled discoverAuto]', err));
});

repairJobDetails().catch(err=>console.error('[startup jobDetails]',err));
cron.schedule(DETAILS_CRON,()=>repairJobDetails().catch(err=>console.error('[scheduled jobDetails]',err)));

guarded('candidateRetry',retryCandidates).catch(err=>console.error('[startup candidateRetry]',err));
cron.schedule(process.env.CANDIDATE_RETRY_CRON||'*/5 * * * *',()=>guarded('candidateRetry',retryCandidates).catch(err=>console.error('[scheduled candidateRetry]',err)));

// Keep the process alive — this file itself IS the "24/7" part.
process.stdin.resume();
