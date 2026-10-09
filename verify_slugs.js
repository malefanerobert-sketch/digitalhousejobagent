#!/usr/bin/env node
const https = require('https');
function get(url){
  return new Promise(resolve => {
    const q = https.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; DHJobAgent/1.0)' },
      timeout: 12000
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => resolve({ code: res.statusCode, body: d.slice(0, 400000) }));
    });
    q.on('timeout', () => { q.destroy(); resolve({ code: 0, body: '' }); });
    q.on('error', () => resolve({ code: 0, body: '' }));
  });
}

const lists = {
  recruitee: ['jobs','tellent','anywhereworks','starr','trackman','yourcareer','recaregmbh','customssupport','egeria','miaplaza','spreadgroup','openclaims','bettercollective','netdata','actionforme','carlfriedrik','consultdss','matresearch'],
  teamtailor: ['career','usgnorthamerica','theherocompany.na','southpole','spiko','realpetfoodcompany','wsa0','yego','root','preferredbynature-1671527207','neat','tfscro','causeway-1588594217','thestudio.na','tusmedia8-1736328817','thealineagroup-1700147786.na','tribebuilders','volue','arrowheadgs','flowcase','swanio','sokin','perkboxvivup'],
  bamboohr: ['aits','a3','armstrongfluidtechnology','baileynelson','401auto','tggaccounting','ritchiestransport','rngd','cmtsllc','smardt','arcetyp','acino','ffun','data4','morrisonexpress'],
  personio: ['open','onecore','openprovider','skalbach-gmbh','stark','viva-fitness','thermondo','tierarztpluspartner','zahneinsgmbh','pmx','bright-consulting-gmbh','fischbach-gruppe','optiker-bode-gmbh'],
  breezy: ['jobs','salt-city-trucking','srs-merchandising','4th-day-trucking','everstar','vanguard-ip','rinvio','kmg-prestige','ensemble-performing-arts','transporting-logistics','crimsonblu','turner-mining-group','asb-freight-co','10-4-truck-recruiting'],
};
const endpoints = {
  recruitee: s => [`https://${s}.recruitee.com/api/offers`],
  teamtailor: s => [`https://${s}.teamtailor.com/jobs.json`],
  bamboohr: s => [`https://${s}.bamboohr.com/careers/list`],
  personio: s => [`https://${s}.jobs.personio.de/search.json`,`https://${s}.jobs.personio.com/search.json`],
  breezy: s => [`https://${s}.breezy.hr/json`],
};
const parse = {
  recruitee: j => (j && Array.isArray(j.offers)) ? j.offers.length : -1,
  teamtailor: j => (j && Array.isArray(j.items)) ? j.items.length : -1,
  bamboohr: j => (j && Array.isArray(j.result)) ? j.result.length : -1,
  personio: j => Array.isArray(j) ? j.length : (j && Array.isArray(j.jobs)) ? j.jobs.length : -1,
  breezy: j => Array.isArray(j) ? j.length : -1,
};
(async () => {
  const out = {}; const examples = {};
  for (const p of Object.keys(endpoints)) {
    out[p] = [];
    for (const s of lists[p]) {
      for (const tpl of endpoints[p](s)) {
        const r = await get(tpl);
        if (r.code !== 200) continue;
        let j; try { j = JSON.parse(r.body); } catch (e) { continue; }
        const n = parse[p](j);
        if (n >= 0) { out[p].push({ slug: s, jobs: n }); if (!examples[p]) examples[p] = j; break; }
      }
    }
    out[p].sort((a,b) => b.jobs - a.jobs);
  }
  require('fs').writeFileSync('ats_slugs.verified.json', JSON.stringify(out, null, 2));
  for (const p of Object.keys(out)) console.log(`${p}: ${out[p].length} slugs, ${out[p].reduce((a,b)=>a+b.jobs,0)} live jobs`);
  console.log('\n--- item shape examples ---');
  for (const p of ['recruitee','teamtailor','bamboohr','personio','breezy']) {
    const j = examples[p]; if (!j) { console.log(p + ': none'); continue; }
    if (Array.isArray(j)) console.log(p + ': ARRAY first keys =', Object.keys(j[0] || {}).slice(0, 22));
    else if (j.offers) console.log(p + ': offers[0] keys =', Object.keys(j.offers[0] || {}).slice(0, 22));
    else if (j.items) console.log(p + ': items[0] keys =', Object.keys(j.items[0] || {}).slice(0, 22));
    else if (j.result) console.log(p + ': result[0] keys =', Object.keys(j.result[0] || {}).slice(0, 22));
  }
})();
