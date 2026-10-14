'use strict';
// In-memory PostgREST-shaped query fixture: never connects to a live service.
function mockDetailsDatabase(input){
 const records=input.map(x=>({...x}));const patches=[];const scans=[];
 return {records,patches,scans,from(table){
  if(table!=='job_matches')throw Error('Unexpected table '+table);
  return {select(){const filters=[];let queue=false;let excludeNotices=false;
   const rows=()=>records.filter(r=>filters.every(([key,value])=>r[key]===value)).filter(r=>!excludeNotices||!['(watched page)','⚠ Watched page could not be read (not a job)'].includes(r.job_title)).filter(r=>!queue||((r.job_description_status!=='captured'||(r.job_description_capture_version||0)<2)&&(!r.job_description_checked_at||Date.parse(r.job_description_checked_at)<Date.now()-6*3600000))).sort((a,b)=>String(a.job_description_checked_at||'').localeCompare(String(b.job_description_checked_at||''))||a.id.localeCompare(b.id));
   const q={or(value){if(!value.includes('job_description_capture_version.lt.2')||!value.includes('job_description_status.is.null'))throw Error('Legacy/null records must be retried');queue=true;return q;},not(){excludeNotices=true;return q;},order(){return q;},eq(k,v){filters.push([k,v]);return q;},async range(a,b){scans.push([a,b]);return {data:rows().slice(a,b+1).map(x=>({...x})),error:null};},then(resolve,reject){return Promise.resolve({data:rows().map(x=>({...x})),error:null}).then(resolve,reject);}};return q;},
   update(patch){return {async eq(key,value){patches.push({key,value,patch:{...patch}});for(const row of records)if(row[key]===value)Object.assign(row,patch);return {error:null};}};}
  };
 }};
}
module.exports={mockDetailsDatabase};
