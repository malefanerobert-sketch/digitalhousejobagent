'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs');
const {isDiscoveryProfileReady,REQUIRED_TEXT_FIELDS,REQUIRED_LIST_FIELDS}=require('./discoveryEligibility');
const ready={full_name:'Synthetic Applicant',date_of_birth:'1990-01-01',gender:'Other',id_type:'passport',id_number:'FIXTURE123',nationality:'South African',phone:'0123456789',job_title_keywords:['Finance Officer'],apply_qualifications:['Diploma'],apply_experience_ranges:['0-1']};
assert(isDiscoveryProfileReady(ready),'Completed profile works without uploaded CV');
assert(!isDiscoveryProfileReady(null));assert(!isDiscoveryProfileReady({full_name:'New Signup'}));
assert(!isDiscoveryProfileReady({resume_url:'https://files.test/cv.pdf'}),'CV file alone does not configure discovery');
for(const field of [...REQUIRED_TEXT_FIELDS,'date_of_birth']) for(const value of [null,undefined,'','   '])assert(!isDiscoveryProfileReady({...ready,[field]:value}),field);
for(const field of REQUIRED_LIST_FIELDS){for(const value of [null,undefined,[],['   '],[null],'Finance Officer'])assert(!isDiscoveryProfileReady({...ready,[field]:value}),field);assert(isDiscoveryProfileReady({...ready,[field]:['  ','Valid selection']}));}
for(const file of ['discoverAuto.js','discoverWatched.js']){
 const source=fs.readFileSync(__dirname+'/'+file,'utf8');assert(source.includes("require('./discoveryEligibility')"));assert(source.includes('.filter(isDiscoveryProfileReady)'));
 const gate=source.indexOf('.filter(isDiscoveryProfileReady)');const loop=source.indexOf(file==='discoverAuto.js'?'for (const user of':'for (const seeker of seekers)',gate);assert(loop>gate,'Gate precedes per-account work');
}
const retry=fs.readFileSync(__dirname+'/candidateQueue.js','utf8');assert(retry.indexOf('if(!isDiscoveryProfileReady(seeker))')<retry.indexOf('const result=await capture('));
for(const field of [...REQUIRED_TEXT_FIELDS,'date_of_birth',...REQUIRED_LIST_FIELDS])assert(retry.includes(field),'Retry query includes '+field);
const sql=fs.readFileSync(__dirname+'/migration_discovery_profile_eligibility.sql','utf8');assert(sql.includes('BEFORE INSERT ON public.job_matches'));assert(!sql.includes('resume_url'));assert(!sql.includes('UPDATE public.job_seekers'));assert(!sql.includes('DELETE FROM'));assert(!sql.includes('DISABLE ROW LEVEL SECURITY'));
console.log('PASS empty signup rejected; all existing required fields and job preferences checked; profile-only CV accepted; auto, watched and retry publication gated; database guard preserves existing records and RLS');
