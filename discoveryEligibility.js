'use strict';
// Discovery uses the already-required profile fields, not a compulsory CV upload.
// Keep in sync with migration_discovery_profile_eligibility.sql.
const REQUIRED_TEXT_FIELDS=['full_name','gender','id_type','id_number','nationality','phone'];
const REQUIRED_LIST_FIELDS=['job_title_keywords','apply_qualifications','apply_experience_ranges'];
const textPresent=value=>typeof value==='string'&&value.trim().length>0;
const listPresent=value=>Array.isArray(value)&&value.some(textPresent);
function isDiscoveryProfileReady(profile){
 return !!profile&&REQUIRED_TEXT_FIELDS.every(key=>textPresent(profile[key]))&&
  textPresent(profile.date_of_birth)&&REQUIRED_LIST_FIELDS.every(key=>listPresent(profile[key]));
}
module.exports={isDiscoveryProfileReady,REQUIRED_TEXT_FIELDS,REQUIRED_LIST_FIELDS};
