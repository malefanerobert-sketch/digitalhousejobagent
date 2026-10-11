const assert=require('assert/strict'),fs=require('fs'),vm=require('vm');
const us=require('./usJobScope');
for(const [code,state] of Object.entries(us.STATES)){
 assert(us.isUSJob({location:state+', United States'}),state);
 assert(us.isUSJob({location:'Example City, '+code}),code);
}
console.log('PASS all 50 states plus DC, including Alaska/Hawaii, names and state codes');
for(const loc of ['São Paulo, Brazil','Okinawa, Japan','Paris, France','Toronto, Canada','Vancouver, CA','Kyiv | Київ, UA','London, UK','Berlin, DE','Mumbai, IN','Remote worldwide','Anywhere','Remote','Georgia','', 'Not in US','Remote - excluding United States'])assert(!us.isUSJob({location:loc}),loc);
console.log('PASS foreign, ambiguous and worldwide-only locations rejected');
for(const loc of ['Remote - US','Remote, USA','United States (remote)','New York City','San Francisco, CA','Anchorage, AK','Honolulu, HI','Washington DC','Paris, TX','Remote in California','Indianapolis, IN'])assert(us.isUSJob({location:loc}),loc);
assert(us.isUSJob({location:'Remote',remote:true,eligible_countries:['US']}));
assert(!us.isUSJob({location:'Remote',description:'Our US office has a team',remote:true}));
console.log('PASS US cities/remote eligibility; employer-description mentions are not location evidence');
for(const loc of [{city:'Ginowan',state:'Okinawa',country:'JP'},{city:'Paris',country:'FR'},{city:'Mississauga',state:'Ontario',country:'CA'}]){
 assert(!us.isUSJob({location:loc}));assert(!us.isUSJob({location:us.locationText(loc)}));assert(!us.isUSJob({location:JSON.stringify(loc)}));
}
for(const loc of [{city:'Egg Harbor Twp',state:'New Jersey',country:'US'},{city:'Unknown rural town',state:'WY',country:'US'}])assert(us.isUSJob({location:loc}));
assert(us.isUSJob({location:'Rural locality',country_code:'US',source:'adzuna'}));assert(!us.isUSJob({location:'Toronto, Canada',country_code:'US'}));
console.log('PASS structured/JSON country metadata preserved; US source hint cannot override clear foreign location');
const auto=fs.readFileSync(__dirname+'/discoverAuto.js','utf8'),watched=fs.readFileSync(__dirname+'/discoverWatched.js','utf8');
assert(auto.includes("const endpoint = 'https://api.adzuna.com/v1/api/jobs/us/search'"));assert(auto.includes('allJobs=allJobs.filter(usScope.isUSJob)'));assert(auto.includes('matches=matches.filter(usScope.isUSJob)'));assert(watched.includes('if(!usScope.isUSJob(job))'));assert(auto.includes('Jobmail is South Africa scoped; skipped'));
const s=auto.indexOf('async function fetchAdzunaJobs'),e=auto.indexOf('/** Fetch US-eligible RemoteOK',s);let fetched;
const ctx=vm.createContext({ADZUNA_APP_ID:'fake',ADZUNA_API_KEY:'fake',URL,console:{log(){},warn(){},error(){}},fetch:async url=>{fetched=new URL(url);return {ok:true,json:async()=>({results:[]})}}});vm.runInContext(auto.slice(s,e),ctx);
(async()=>{await ctx.fetchAdzunaJobs({api_endpoint:'https://api.adzuna.com/v1/api/jobs/za/search'},'assistant');assert(fetched.pathname.includes('/jobs/us/search/1'));assert(!fetched.searchParams.has('where'));console.log('PASS stale country endpoint cannot override US; no city narrowing in nationwide request');console.log('ALL US-SCOPE TESTS PASSED — no live API calls');})().catch(e=>{console.error(e);process.exit(1)});
