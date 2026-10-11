/** South Africa-only discovery. Stored archive is never deleted by this gate. */
const usScope=require('./usJobScope');
const PROVINCES=['Eastern Cape','Free State','Gauteng','KwaZulu-Natal','Limpopo','Mpumalanga','Northern Cape','North West','Western Cape'];
const CITIES=/\b(?:johannesburg|joburg|jhb|jozi|cape town|durban|pretoria|tshwane|centurion|sandton|midrand|randburg|roodepoort|soweto|fourways|bryanston|ekurhuleni|kempton park|boksburg|benoni|alberton|brakpan|krugersdorp|bloemfontein|gqeberha|port elizabeth|east london|pietermaritzburg|polokwane|nelspruit|mbombela|kimberley|rustenburg|stellenbosch|vereeniging|vanderbijlpark|emalahleni|witbank|potchefstroom|mahikeng|mafikeng|mthatha|umtata|richards bay|paarl|somerset west|mossel bay|oudtshoorn|tzaneen)\b/i;
const ZA=/\b(?:south africa|rsa|zaf|za)\b/i;
const FOREIGN=/\b(?:united states|usa|u\.s\.?|canada|brazil|brasil|japan|france|united kingdom|england|germany|india|australia|new zealand|china|singapore|mexico|argentina|spain|italy|netherlands|ireland|ukraine|russia|philippines|pakistan|israel|uae|nigeria|kenya|egypt|turkey)\b/i;
function isZAJob(job){
 let o=job.location;if(typeof o==='string'){try{o=JSON.parse(o);}catch(_){o=null;}}
 if(o&&typeof o==='object'&&!Array.isArray(o)){
  const codes=[o.country,o.countryCode,o.countryName,o.country_name,o.addressCountry].filter(Boolean).map(c=>typeof c==='object'?(c.name||c.code||c.value):c);
  if(codes.length&&codes.some(c=>!/^(?:za|zaf|rsa|south africa)$/i.test(String(c).trim())))return false;
 }
 const loc=usScope.locationText(job.location);
 if(/\b(?:outside|excluding|except|not in|non)[\s-]+(?:the )?(?:south africa|za|rsa)\b/i.test(loc))return false;
 if(ZA.test(loc))return true;
 if(FOREIGN.test(loc)||usScope.isUSJob({location:loc}))return false;
 if(/(?:^|[,;/\s])(?:BR|JP|FR|UK|GB|AU|NZ|CN|MX|SG|IE|UA)(?:$|[,;/\s])/i.test(loc))return false;
 if(job.country_code==='ZA')return true; // authoritative ZA endpoint/native ZA board only
 if(job.remote&&Array.isArray(job.eligible_countries)&&job.eligible_countries.some(c=>/^(?:za|zaf|rsa|south africa)$/i.test(String(c))))return true;
 if(PROVINCES.some(p=>loc.toLowerCase().includes(p.toLowerCase()))||/\b(?:kzn)\b/i.test(loc)||CITIES.test(loc))return true;
 return false; // Worldwide / Remote / missing location alone is not ZA evidence
}
function isNativeZASource(url){try{const h=new URL(url).hostname.toLowerCase();return ['pnet.co.za','careers24.com','careerjunction.co.za','jobmail.co.za','executiveplacements.com','careers.capitecbank.co.za'].some(x=>h===x||h.endsWith('.'+x));}catch(_){return false;}}
module.exports={PROVINCES,isZAJob,isNativeZASource,locationText:usScope.locationText};
