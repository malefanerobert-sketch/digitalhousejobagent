'use strict';
const {isDiscoveryProfileReady}=require('./discoveryEligibility');
// Worker-only holding area. Incomplete candidates are durable, but never appear
// in applicant Matches or the admin application queue until capture succeeds.
const details=require('./jobDetails');
const FIELDS=['job_seeker_id','job_source_id','job_custom_source_id','job_title','company_name','employer_name','job_description','job_description_status','job_description_capture_version','job_description_checked_at','location','job_url','salary_text','match_score','status','skip_reason','discovered_at','match_reason','is_custom_source','user_marked_applied'];
const cleanPayload=row=>Object.fromEntries(FIELDS.filter(key=>row[key]!==undefined).map(key=>[key,row[key]]));
async function deferCandidates(sb,rows,{now=()=>Date.now()}={}){
 if(!rows.length)return;
 const saved=rows.map(row=>({job_seeker_id:row.job_seeker_id,job_url:row.job_url,payload:{...cleanPayload(row),_discovery_country:'ZA'},next_attempt_at:new Date(now()+5*60000).toISOString(),last_error:'Awaiting complete publisher advert'}));
 const {error}=await sb.from('job_discovery_candidates').upsert(saved,{onConflict:'job_seeker_id,job_url',ignoreDuplicates:true});
 if(error)throw new Error('Could not preserve unpublished candidates: '+error.message);
 console.log(`[candidate-queue] Preserved ${saved.length} candidate(s) for retry; not published as incomplete Matches`);
}
let inFlight=null;
function processCandidates(sb,options={}){
 if(inFlight)return inFlight;
 inFlight=drain(sb,options).finally(()=>{inFlight=null;});return inFlight;
}
async function drain(sb,{limit=8,now=()=>Date.now(),capture=details.captureJobDetails,fit,scope}={}){
 fit=fit||require('./jobFit');scope=scope||require('./zaJobScope');
 const {data:rows,error}=await sb.from('job_discovery_candidates').select('*').lte('next_attempt_at',new Date(now()).toISOString()).order('next_attempt_at',{ascending:true}).order('id',{ascending:true}).limit(200);
 if(error)throw new Error('Candidate retry query failed: '+error.message);
 const seen=new Set();let published=0,retried=0;
 for(const candidate of rows||[]){
  if(!seen.has(candidate.job_url)&&seen.size>=limit)continue;seen.add(candidate.job_url);
  // An atomic time-lease prevents two replicas processing this candidate at once.
  const lease=new Date(now()+15*60000).toISOString();
  const {data:claim,error:claimError}=await sb.from('job_discovery_candidates').update({next_attempt_at:lease}).eq('id',candidate.id).eq('next_attempt_at',candidate.next_attempt_at).select('id');
  if(claimError||!claim?.length)continue;
  retried++;
  const attempts=(candidate.attempts||0)+1;
  const hold=async(reason)=>{
   const delay=Math.min(6*3600000,5*60000*Math.pow(2,Math.min(attempts-1,7)));
   const {error}=await sb.from('job_discovery_candidates').update({attempts,next_attempt_at:new Date(now()+delay).toISOString(),last_error:String(reason).slice(0,400),updated_at:new Date(now()).toISOString()}).eq('id',candidate.id);
   if(error)throw new Error('Could not reschedule preserved candidate: '+error.message);
  };
  try{
   const {data:seeker,error:seekerError}=await sb.from('job_seekers').select('full_name,date_of_birth,gender,id_type,id_number,nationality,phone,id,status,auto_search_enabled,discovery_mode,api_provider,blocked_companies,blocked_locations,preferred_locations,job_title_keywords,highest_qualification,apply_qualifications,apply_experience_ranges').eq('id',candidate.job_seeker_id).maybeSingle();
   if(seekerError)throw seekerError;
   if(!seeker||seeker.status!=='active'){await hold('Account is not active');continue;}
   if(!isDiscoveryProfileReady(seeker)){await hold('Account is waiting for existing profile requirements');continue;}
   const payload=cleanPayload(candidate.payload||{});
   if(!payload.is_custom_source&&(!seeker.auto_search_enabled||!['auto','both'].includes(seeker.discovery_mode))){await hold('Autonomous discovery is disabled for this account');continue;}
   if(seeker.api_provider==='none'){await hold('Account agent is disabled');continue;}
   const blocked=(seeker.blocked_companies||[]).map(x=>String(x).trim().toLowerCase());
   if([payload.company_name,payload.employer_name].some(x=>x&&blocked.includes(String(x).trim().toLowerCase()))){await hold('Company is blocked for this account');continue;}
   if((seeker.blocked_locations||[]).filter(x=>String(x).trim()).some(x=>String(payload.location||'').toLowerCase().includes(String(x).trim().toLowerCase()))){await hold('Location is blocked for this account');continue;}
   if(payload.job_custom_source_id){
    const {data:source,error}=await sb.from('job_custom_sources').select('id,active').eq('id',payload.job_custom_source_id).maybeSingle();if(error)throw error;
    const {data:optout,error:optoutError}=await sb.from('job_custom_source_optouts').select('job_seeker_id').eq('job_seeker_id',candidate.job_seeker_id).eq('job_custom_source_id',payload.job_custom_source_id).maybeSingle();if(optoutError)throw optoutError;
    if(!source?.active||optout){await hold('Watched source is disabled or opted out');continue;}
   }else if(payload.job_source_id){
    const {data:source,error}=await sb.from('job_sources').select('id,active').eq('id',payload.job_source_id).maybeSingle();if(error)throw error;
    const {data:preference,error:preferenceError}=await sb.from('user_job_sources').select('enabled').eq('user_id',candidate.job_seeker_id).eq('job_source_id',payload.job_source_id).maybeSingle();if(preferenceError)throw preferenceError;
    if(!source?.active||preference?.enabled!==true){await hold('Feed source is disabled');continue;}
   }
   const result=await capture(candidate.job_url,{title:payload.job_title,employer:payload.employer_name||''});
   const fresh=details.storedJobDetails(result,payload.job_description,payload.employer_name);
   if(!details.canPublishJobDetails(fresh,payload.job_title)){await hold(result.errorCode||'Full advert or required publisher facts still unavailable');continue;}
   if(!scope.isZAJob({title:payload.job_title,location:payload.location,url:payload.job_url,country_code:candidate.payload?._discovery_country})){await hold('Job location is outside supported discovery scope');continue;}
   if(blocked.includes(String(fresh.employer_name||'').trim().toLowerCase())){await hold('Employer is blocked for this account');continue;}
   const why=fit.titleSkipReason(payload.job_title,seeker);
   const skip=why?fit.skipMessage(why):!fit.locationInScope(payload.location,seeker.preferred_locations)?'Outside your preferred locations. Request Apply to ask an admin to apply anyway.':null;
   const row={...payload,...fresh,status:skip?'skipped':'pending',skip_reason:skip};
   // Preserve existing matches and all user/admin decisions; only insert new ones.
   const {data:existing,error:existingError}=await sb.from('job_matches').select('id,employer_name,company_name,location').eq('job_seeker_id',candidate.job_seeker_id).eq('job_title',row.job_title);if(existingError)throw existingError;
   const norm=x=>String(x||'').toLowerCase().replace(/\s+/g,' ').trim();
   const duplicate=(existing||[]).some(x=>norm(x.employer_name||x.company_name)===norm(row.employer_name||row.company_name)&&norm(x.location)===norm(row.location));
   if(!duplicate){
    const {data:inserted,error}=await sb.from('job_matches').upsert([row],{onConflict:'job_seeker_id,job_url',ignoreDuplicates:true}).select('id');
    if(error)throw error;published+=(inserted||[]).length;
   }
   const {error:deleteError}=await sb.from('job_discovery_candidates').delete().eq('id',candidate.id);if(deleteError)throw deleteError;
  }catch(error){await hold('Retry failed: '+(error.message||'Unknown error'));}
 }
 console.log(`[candidate-queue] Retried ${retried}; published ${published} complete new match(es); incomplete candidates remain preserved`);
 return {retried,published};
}
module.exports={deferCandidates,processCandidates};
