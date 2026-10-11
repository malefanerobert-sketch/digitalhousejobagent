const assert=require('node:assert/strict');
// Display the saved event timestamp, not the current clock. SAST is UTC+02:00 year-round.
function discoveryDate(value){
  if(!value)return 'Date and time unavailable';
  const d=new Date(value);
  if(Number.isNaN(d.getTime()))return 'Date and time unavailable';
  const date=d.toLocaleDateString('en-ZA',{timeZone:'Africa/Johannesburg',year:'numeric',month:'short',day:'numeric'});
  const time=d.toLocaleTimeString('en-ZA',{timeZone:'Africa/Johannesburg',hour:'2-digit',minute:'2-digit',hourCycle:'h23'});
  return date+' · '+time;
}
assert.equal(discoveryDate(null),'Date and time unavailable');assert.equal(discoveryDate('bad'),'Date and time unavailable');const v=discoveryDate('2026-10-10T23:05:09Z');assert(v.includes('11'));assert(v.endsWith('01:05'));assert.equal(v,discoveryDate('2026-10-11T01:05:09+02:00'));console.log('PASS actual stored timestamp, hours/minutes, SAST timezone, midnight rollover and missing/invalid values');
