require('dotenv').config();
const cron = require('node-cron');
const discover = require('./discover');
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
discover.run().catch(err => console.error('[startup discover]', err));

cron.schedule(DISCOVER_CRON, () => {
  discover.run().catch(err => console.error('[scheduled discover]', err));
});

cron.schedule(APPLY_CRON, () => {
  apply.run().catch(err => console.error('[scheduled apply]', err));
});

// Keep the process alive — this file itself IS the "24/7" part.
// It needs to run on a host that keeps a Node process alive continuously
// (see README.md for hosting options). It will NOT work on Netlify Functions
// or Supabase Edge Functions, since those are short-lived/serverless.
process.stdin.resume();
