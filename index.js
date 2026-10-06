require('dotenv').config();
const cron = require('node-cron');
// Two discovery paths run alongside each other, both South-Africa focused:
// discoverWatched.js handles Watched pages (SA company / job-board pages a
// user explicitly adds), and discoverAuto.js runs autonomous Adzuna ZA /
// RemoteOK / Jobmail search. So the Agent gets both: pages users add, and
// jobs it finds on its own.
const discoverWatched = require('./discoverWatched');
const discoverAuto = require('./discoverAuto');
const apply = require('./apply');

const WATCH_CRON = process.env.WATCH_CRON || '0 */3 * * *';     // watched pages — every 3 hours by default
const DISCOVER_CRON = process.env.DISCOVER_CRON || '0 */3 * * *'; // autonomous Adzuna/RemoteOK/Jobmail search — every 3 hours by default
const APPLY_CRON = process.env.APPLY_CRON || '*/20 * * * *';    // every 20 min by default

console.log('=================================================');
console.log(' Dispatch Agent Worker — starting up');
console.log(' watched-pages schedule:  ', WATCH_CRON);
console.log(' autonomous-search sched.:', DISCOVER_CRON);
console.log(' apply schedule:          ', APPLY_CRON);
console.log('=================================================');

// Run once immediately on startup so you see activity right away,
// then settle into the scheduled cadence.
discoverWatched.run().catch(err => console.error('[startup discoverWatched]', err));
discoverAuto.run().catch(err => console.error('[startup discoverAuto]', err));

cron.schedule(WATCH_CRON, () => {
  discoverWatched.run().catch(err => console.error('[scheduled discoverWatched]', err));
});

cron.schedule(DISCOVER_CRON, () => {
  discoverAuto.run().catch(err => console.error('[scheduled discoverAuto]', err));
});

cron.schedule(APPLY_CRON, () => {
  apply.run().catch(err => console.error('[scheduled apply]', err));
});

// Keep the process alive — this file itself IS the "24/7" part.
process.stdin.resume();
