const fs=require('fs'),assert=require('node:assert/strict');
const web=fs.readFileSync(__dirname+'/index.html','utf8'),admin=fs.readFileSync(__dirname+'/admin.html','utf8'),worker=fs.readFileSync(__dirname+'/apply.js','utf8'),sql=fs.readFileSync(__dirname+'/migration_optional_application_guidance.sql','utf8');
for(const text of [web,admin,worker]) {assert(!text.includes('get_application_readiness'));assert(!text.includes('confirm_application_profile'));assert(!text.includes('pfConfirmReal'));}
for(const text of ['I confirm that my saved information','New discovery covers South Africa only. US company feeds','Railway does not apply; click Apply'])assert(!web.includes(text));
assert(web.includes('Help employers get to know you'));assert(web.includes('You can add more details later'));assert(web.includes("rpc('request_job_application'"));
assert(!sql.includes('get_application_readiness'));assert(sql.includes('This is not your match'));assert(sql.includes('submission_unverified'));assert(sql.includes('blocked in your profile'));
console.log('PASS encouragement-only profile guidance, statements removed, no readiness gate in frontend/admin/worker/backend, existing owner/duplicate/block safeguards preserved');
