require('dotenv').config();
const cron = require('node-cron');
// discoverCustom.js (the structured Greenhouse/Lever/Ashby/SmartRecruiters/
// Workable catalog approach, driven by the job_sources table) has been
// retired — Dispatch now runs entirely on user-added Watched pages. Railway
// itself still hosts the process; what changed is that there's no more
// fixed-catalog scraping, only the Agent visiting whatever pages users add.
const discoverWatched = require('./discoverWatched');
const apply = require('./apply');

const WATCH_CRON = process.env.WATCH_CRON || '0 */3 * * *';   // every 3 hours by default
const APPLY_CRON = process.env.APPLY_CRON || '*/20 * * * *';  // every 20 min by default

console.log('=================================================');
console.log(' Dispatch Agent Worker — starting up');
console.log(' watched-pages schedule:', WATCH_CRON);
console.log(' apply schedule:        ', APPLY_CRON);
console.log('=================================================');

// Run once immediately on startup so you see activity right away,
// then settle into the scheduled cadence.
discoverWatched.run().catch(err => console.error('[startup discoverWatched]', err));

cron.schedule(WATCH_CRON, () => {
  discoverWatched.run().catch(err => console.error('[scheduled discoverWatched]', err));
});

cron.schedule(APPLY_CRON, () => {
  apply.run().catch(err => console.error('[scheduled apply]', err));
});

// Keep the process alive — this file itself IS the "24/7" part.
process.stdin.resume();
