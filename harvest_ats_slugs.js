#!/usr/bin/env node
// Harvests VERIFIED ATS company slugs by hitting each platform's public job-feed endpoint.
// Only slugs whose endpoint returns HTTP 200 + parseable jobs are kept. Nothing is guessed as truth.
const https = require('https');

const PLATFORMS = {
  recruitee:  { templates: s => [`https://${s}.recruitee.com/api/offers`], parse: j => (j.offers||[]).length, root:'offers' },
  bamboohr:   { templates: s => [`https://${s}.bamboohr.com/careers/list`], parse: j => (j.result||[]).length, root:'result' },
  personio:   { templates: s => [`https://${s}.jobs.personio.de/search.json`,`https://${s}.jobs.personio.com/search.json`], parse: j => (Array.isArray(j)?j.length:(j.jobs||[]).length), root:null },
  teamtailor: { templates: s => [`https://${s}.teamtailor.com/jobs.json`], parse: j => (j.items||[]).length, root:'items' },
  breezy:     { templates: s => [`https://${s}.breezy.hr/json`], parse: j => (Array.isArray(j)?j.length:0), root:null },
  jazzhr:     { templates: s => [`https://${s}.applytojob.com/apply/jobs.json`,`https://api.jazzhr.com/v1/jobs/embed/${s}`], parse: j => (Array.isArray(j)?j.length:(j.jobs||[]).length), root:null },
};

const SLUGS = {
  recruitee: ['mews','tripleten'].concat([
    'VDK Groep B.V.','ASVZ','Sterk in Matches B.V.','Regio Zustellservice GmbH','GGz Centraal',
    'ANGEHEUERT GmbH','Dura Vermeer','Moore MKW','Friday Recruitment','Cordaan',
    'Primegate consulting GmbH','SPAR','Maximizd','Boulangerie Ange','Werken bij HANOS','EWOR GmbH',
    'BAS Group','Koninklijke Sportfondsen Nederland B.V.','Van den Udenhout Groep','KWS Infra'
  ]),
  bamboohr: ['aits','a3'].concat([
    'University of Pikeville','Armstrong Fluid Technology','The Weitz Company','Bailey Nelson',
    'OpenRoad Auto Group','401 Auto','TGG Accounting','Johnson Controls Federal Systems',
    'Fessler & Bowman Inc','Ritchies Transport','RNGD','CMTS LLC','Smardt','Arcetyp LLC','Acino',
    'Ascension Recovery Services','FFUN Group','Data4','Morrison Express'
  ]),
  personio: ['open','onecore','openprovider'].concat([
    '1KOMMA5°','Skalbach GmbH','APELOS Therapie GmbH','STARK','Sungrow Europe','Viva Fitness',
    'Thermondo GmbH','Tierarzt Plus Partner','vitronet Gruppe','Scalian Germany AG','zahneins GmbH',
    'pmX Group','TMS Trademarketing Service GmbH','PEPCO Germany','Bleker Gruppe',
    'BRIGHT Consulting GmbH','Fischbach Gruppe','Tiemeyer automobile GmbH & Co. KG','Optiker Bode GmbH'
  ]),
  teamtailor: ['career'].concat([
    'Migen Service','TeachMe.To','Tantor','TECDATA ENGINEERING','Blue','Lovisa','Job Squad',
    'Gp pride','Bellocco Valentina','Urban Ridge Supplies','Exio','G.M.S.','impiegando.com',
    'RAS Interim','La Casa de las Carcasas','Andromeda','Simplex Bemanning AB','AFTRAL',
    'Speed Recruiting','CVS Hiring'
  ]),
  breezy: ['jobs'].concat([
    'Delan Associates, Inc','Salt City Trucking','SRS Merchandising','4th Day Trucking','Everstar',
    'CLFC Healthcare and Communications','Vanguard-IP','Sage Haus','Surge Staffing','HIKINEX',
    'Kimmel & Associates','Rinvio','Commonwealth Health','KMG Prestige','Ensemble Performing Arts',
    'Transporting Logistics','CrimsonBlu','Turner Mining Group','ASB Freight Co.','10-4 Truck Recruiting'
  ]),
  jazzhr: ['jazzwebinars','360careers','hrworks','careers'].concat([
    'MileHigh Adjusters Houston Inc','AO Globe Life','FAR Inspections','Bright Vision Technologies','CCMI',
    'The Joint Chiropractic','Ethos Veterinary Health','NorthPoint Search Group','Globe Life AO','Ladder',
    'Language Trainers','Meals Now','WhiteWater Express Car Wash','IntelliPro Group Inc.',
    'Globe Life AIL','Ladgov Corporation','US Ghost Adventures','HEALTHCARE RECRUITMENT COUNSELORS','AIL','CAMBA'
  ]),
};

function norm(name){
  let s = String(name).toLowerCase();
  s = s.replace(/\u00df/g,'ss').replace(/\u00e4/g,'ae').replace(/\u00f6/g,'oe').replace(/\u00fc/g,'ue');
  s = s.normalize('NFKD').replace(/[\u0300-\u036f]/g,'');
  s = s.replace(/&/g,' and ').replace(/[^a-z0-9]+/g,' ').trim();
  const words = s.split(/\s+/).filter(w => w && !['the'].includes(w));
  let out = [];
  for (const sep of ['', '-']) {
    out.push(words.join(sep));
    let strip = words.filter(w => !['inc','llc','ltd','corp','co','gmbh','group','b','v'].includes(w));
    if (strip.length && strip.join(sep) !== words.join(sep)) out.push(strip.join(sep));
  }
  return [...new Set(out)].filter(Boolean);
}

function get(url){
  return new Promise(resolve => {
    const req = https.get(url, { headers:{'User-Agent':'Mozilla/5.0 (compatible; DHJobAgent/1.0)'}, timeout: 12000 }, res => {
      let d=''; res.on('data',c=>d+=c); res.on('end',()=>resolve({code:res.statusCode, body:d.slice(0,400000)}));
    });
    req.on('timeout',()=>{req.destroy();resolve({code:0,body:''});});
    req.on('error',()=>resolve({code:0,body:''}));
  });
}

(async () => {
  for (const [ptype, cfg] of Object.entries(PLATFORMS)) {
    const raw = SLUGS[ptype] || [];
    // expand name candidates into candidate slugs, keep explicit short tokens too
    let candidates = [];
    for (const c of raw) {
      if (/^[a-z0-9.-]+$/.test(String(c).toLowerCase()) && !/\s/.test(c)) candidates.push(c.toLowerCase());
      else candidates.push(...norm(c));
    }
    candidates = [...new Set(candidates)];
    const url = `https://${candidates[0]}.xx`; // placeholder prevents lint complaints
    // probe up to N candidates per platform
    const found = [];
    for (const slug of candidates) {
      for (const tpl of cfg.templates(slug)) {
        const r = await get(tpl);
        if (r.code !== 200) continue;
        try {
          const j = JSON.parse(r.body);
          const n = cfg.parse(j);
          if (n >= 0) { found.push({slug, jobs:n, url:tpl}); break; }
        } catch(e){}
      }
      if (found.length && found[found.length-1].slug === slug) {} // keep going
      if (found.length >= 60) break;
    }
    console.log(`\n===== ${ptype} — ${found.length} verified slugs =====`);
    for (const f of found) console.log(`${f.jobs}\t${f.slug}\t${f.url}`);
  }
})();
