/** Nationwide US discovery gate. Never infer country from employer HQ or job description. */
const STATES={AL:'Alabama',AK:'Alaska',AZ:'Arizona',AR:'Arkansas',CA:'California',CO:'Colorado',CT:'Connecticut',DE:'Delaware',FL:'Florida',GA:'Georgia',HI:'Hawaii',ID:'Idaho',IL:'Illinois',IN:'Indiana',IA:'Iowa',KS:'Kansas',KY:'Kentucky',LA:'Louisiana',ME:'Maine',MD:'Maryland',MA:'Massachusetts',MI:'Michigan',MN:'Minnesota',MS:'Mississippi',MO:'Missouri',MT:'Montana',NE:'Nebraska',NV:'Nevada',NH:'New Hampshire',NJ:'New Jersey',NM:'New Mexico',NY:'New York',NC:'North Carolina',ND:'North Dakota',OH:'Ohio',OK:'Oklahoma',OR:'Oregon',PA:'Pennsylvania',RI:'Rhode Island',SC:'South Carolina',SD:'South Dakota',TN:'Tennessee',TX:'Texas',UT:'Utah',VT:'Vermont',VA:'Virginia',WA:'Washington',WV:'West Virginia',WI:'Wisconsin',WY:'Wyoming',DC:'District of Columbia'};
const FOREIGN=/\b(?:brazil|brasil|japan|france|canada|united kingdom|england|scotland|ireland|germany|india|south africa|australia|new zealand|china|singapore|mexico|argentina|colombia|chile|peru|spain|italy|netherlands|belgium|switzerland|sweden|norway|denmark|finland|poland|portugal|ukraine|russia|pakistan|bangladesh|philippines|indonesia|thailand|vietnam|malaysia|hong kong|taiwan|south korea|israel|uae|united arab emirates|saudi arabia|nigeria|kenya|egypt|turkey|türkiye)\b/i;
const US=/\b(?:united states(?: of america)?|usa|u\.s\.a\.?|u\.s\.?|us)\b/i;
const CITIES=/\b(?:new york city|nyc|san francisco|san jose|san diego|los angeles|sacramento|seattle|chicago|boston|philadelphia|pittsburgh|atlanta|miami|tampa|orlando|dallas|houston|austin|san antonio|denver|phoenix|tucson|las vegas|salt lake city|detroit|minneapolis|milwaukee|cleveland|cincinnati|indianapolis|louisville|nashville|memphis|charlotte|raleigh|baltimore|washington dc|anchorage|honolulu|boise|albuquerque|omaha|des moines|wichita|little rock|baton rouge|new orleans|birmingham|jacksonville)\b/i;
function objectLocation(value){
 if(typeof value==='string'){try{const x=JSON.parse(value);if(x&&typeof x==='object')return x;}catch(_){}}return value&&typeof value==='object'?value:null;
}
function textField(v){return typeof v==='string'?v:(v&&typeof v==='object'?(v.name||v.code||v.value||''):'');}
function locationText(v){
 const o=objectLocation(v);if(!o)return String(v||'').trim();
 if(Array.isArray(o))return o.map(locationText).filter(Boolean).join(' / ');
 const labels={US:'United States',USA:'United States',CA:'Canada',BR:'Brazil',JP:'Japan',FR:'France',GB:'United Kingdom',UK:'United Kingdom',DE:'Germany',IN:'India',AU:'Australia',NZ:'New Zealand',ZA:'South Africa',CN:'China',MX:'Mexico',SG:'Singapore',IE:'Ireland',UA:'Ukraine'};
 const countryLabels=[o.country,o.countryCode,o.countryName,o.country_name,o.addressCountry].map(textField).filter(Boolean).map(x=>labels[String(x).toUpperCase()]||(/^[A-Z]{2,3}$/i.test(x)?'Country: '+x:x));
 return [...new Set([o.name,o.city,o.addressLocality,o.state,o.region,o.addressRegion].map(textField).filter(Boolean).concat(countryLabels))].join(', ');
}
function countryValue(v){const s=String(textField(v)||'').trim();if(/^(?:us|usa|united states(?: of america)?|u\.s\.?|u\.s\.a\.?)$/i.test(s))return 'US';return s?'FOREIGN':null;}
function isUSJob(job){
 const raw=job.location,object=objectLocation(raw);
 const countries=object&&!Array.isArray(object)?[object.country,object.countryCode,object.countryName,object.country_name,object.addressCountry].filter(Boolean):[];
 // Country metadata on the actual location takes priority over city/state guesses.
 if(countries.length&&countries.some(c=>countryValue(c)==='FOREIGN'))return false;
 const loc=locationText(raw);
 if(/\b(?:outside|excluding|except|not in|non)[\s-]+(?:the )?(?:us|usa|united states)\b/i.test(loc))return false;
 if(/Country:\s*(?!US\b|USA\b)[A-Z]{2,3}\b/i.test(loc))return false;
 const explicitUS=US.test(loc);
 if(FOREIGN.test(loc)&&!explicitUS)return false;
 if(countries.some(c=>countryValue(c)==='US')||explicitUS)return true;
 if(/(?:^|[,;/\s])(?:BR|JP|FR|UK|GB|ZA|AU|NZ|CN|MX|SG|IE|UA)(?:$|[,;/\s])/i.test(loc))return false;
 if(/\b(?:tokyo|osaka|okinawa|kyoto|toronto|montreal|vancouver|bengaluru|bangalore|mumbai|hyderabad|new delhi|kolkata|berlin|munich|sao paulo|rio de janeiro|bogota|buenos aires)\b/i.test(loc)&&!US.test(loc))return false;
 // Adzuna's US endpoint is authoritative when a display label omits the country.
 if(job.country_code==='US'&&!FOREIGN.test(loc))return true;
 // An explicit eligible-country list may qualify remote positions, not a description mention.
 if(job.remote&&Array.isArray(job.eligible_countries)&&job.eligible_countries.some(c=>countryValue(c)==='US'))return true;
 const low=loc.toLowerCase();
 if(Object.values(STATES).some(s=>s!=='Georgia'&&new RegExp('\\b'+s.toLowerCase()+'\\b').test(low)))return true;
 // State codes need city/state punctuation, not common English words such as "in" or "or".
 const code=loc.match(/,\s*([A-Z]{2})(?=\s*(?:$|,|\d{5}|\)|\/))/)?.[1];
 if(code&&STATES[code])return true;
 if(CITIES.test(loc))return true;
 return false; // worldwide/remote/blank/ambiguous isn't evidence of US eligibility
}
module.exports={STATES,locationText,isUSJob};
