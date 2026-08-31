require('dotenv').config();
const cron = require('node-cron');
// discover.js was retired — it was an older, narrower duplicate of
// discoverCustom.js (Greenhouse/Lever only, and its AI scoring had been
// silently broken by a stale function signature). discoverCustom.js does
// everything it did, correctly, plus Ashby/SmartRecruiters/Workable.
const discoverCustom = require('./discoverCustom');
const discoverWatched = require('./discoverWatched');
const apply = require('./apply');

const DISCOVER_CRON = process.env.DISCOVER_CRON || '0 * * * *';     // every hour by default
const APPLY_CRON = process.env.APPLY_CRON || '*/20 * * * *';        // every 20 min by default

console.log('=================================================');
console.log(' DigitalHouse Job Agent Worker — starting up');
console.log(' discover schedule:', DISCOVER_CRON);
console.log(' apply schedule:   ', APPLY_CRON);
console.log('=================================================');

// Run once immediately on startup so you see activity right away,
// then settle into the scheduled cadence.
discoverCustom.run().catch(err => console.error('[startup discoverCustom]', err));
discoverWatched.run().catch(err => console.error('[startup discoverWatched]', err));

cron.schedule(DISCOVER_CRON, () => {
  discoverCustom.run().catch(err => console.error('[scheduled discoverCustom]', err));
  discoverWatched.run().catch(err => console.error('[scheduled discoverWatched]', err));
});

cron.schedule(APPLY_CRON, () => {
  apply.run().catch(err => console.error('[scheduled apply]', err));
});

// Keep the process alive — this file itself IS the "24/7" part.
// It needs to run on a host that keeps a Node process alive continuously
// (see README.md for hosting options). It will NOT work on Netlify Functions
// or Supabase Edge Functions, since those are short-lived/serverless.
process.stdin.resume();
