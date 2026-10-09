# ATS Platforms — Verified Slugs + Working Feed Endpoints

All slugs below are REAL and VERIFIED by hitting each platform's public feed and receiving HTTP 200 + parseable job data. No guessed/fake slugs. Verified run date: today. Nothing pushed.

## Verified total (new platforms, real live jobs right now)

| Platform | Verified slugs | Live jobs now |
|---|---|---|
| Breezy | 14 | 3,117 |
| Personio | 13 | 1,255 |
| BambooHR | 15 | 1,154 |
| Teamtailor | 16 | 243 |
| Recruitee | 14 | 69 |
| **Total** | **72** | **5,838** |

Plus the 5 already wired (Greenhouse, Lever, SmartRecruiters, Ashby, Workable).

## Verified slugs (paste into ATS_BOARDS)

```js
recruitee: ['bettercollective','jobs','matresearch','recaregmbh','starr','miaplaza','spreadgroup','anywhereworks','yourcareer','openclaims','carlfriedrik','egeria','tellent','actionforme'],
teamtailor: ['usgnorthamerica','neat','tfscro','volue','southpole','swanio','perkboxvivup','causeway-1588594217','sokin','root','tribebuilders','realpetfoodcompany','wsa0','arrowheadgs','theherocompany.na','career'],
bamboohr: ['armstrongfluidtechnology','arcetyp','401auto','baileynelson','morrisonexpress','tggaccounting','ritchiestransport','cmtsllc','rngd','smardt','a3','ffun','data4','acino','aits'],
personio: ['skalbach-gmbh','bright-consulting-gmbh','viva-fitness','stark','thermondo','tierarztpluspartner','zahneinsgmbh','pmx','fischbach-gruppe','optiker-bode-gmbh','open','onecore','openprovider'],
breezy: ['srs-merchandising','everstar','rinvio','transporting-logistics','vanguard-ip','turner-mining-group','10-4-truck-recruiting','ensemble-performing-arts','salt-city-trucking','crimsonblu','asb-freight-co','kmg-prestige','4th-day-trucking','jobs'],
```

`ats_slugs.verified.json` in this folder has the same lists with live job counts.

## Feed endpoints — WHAT ACTUALLY WORKS (curl-verified)

| Platform | Method (existing code) | Correct endpoint | Parse |
|---|---|---|---|
| Greenhouse | OK (existing) | `boards-api.greenhouse.io/v1/boards/{slug}/jobs` | `.jobs[]` |
| Lever | OK (existing) | `api.lever.co/v0/postings/{slug}?mode=json` | `[]` |
| SmartRecruiters | OK (existing) | `api.smartrecruiters.com/v1/companies/{slug}/postings` | `.content[]` |
| Ashby | OK (existing) | `api.ashbyhq.com/posting-api/job-board/{slug}` | `.jobs[]` |
| Workable | OK (existing) | `apply.workable.com/api/v1/widget/accounts/{slug}` | `.jobs[]` |
| Recruitee | OK endpoint, field fixes | `https://{slug}.recruitee.com/api/offers` | `.offers[]` |
| BambooHR | endpoint OK, URL field broken | `https://{slug}.bamboohr.com/careers/list` | `.result[]` |
| Personio | endpoint OK, URL field broken | `https://{slug}.jobs.personio.de/search.json` | `[]` (bare array) |
| Teamtailor | endpoint WRONG in code | `https://{slug}.teamtailor.com/jobs.json` (NOT `/api/v1/jobs`) | `.items[]` |
| Breezy | no fetch code | `https://{slug}.breezy.hr/json` | `[]` (bare array) |

## Dead platforms — NO public per-company JSON feed (verified, not speculation)

| Platform | Evidence |
|---|---|
| JazzHR | Board HTML is server-rendered, no JSON in page; `api.jazzhr.com` unreachable; official API needs key |
| Comeet | `comeet.co/careers-api/2.0/company/{uid}/positions` → HTTP 400 "Token is missing" |
| Jobvite | `jobs.jobvite.com/{slug}` is an HTML SPA, no feed endpoint |
| Fountain | no public per-company jobs endpoint |
| Pinpoint | no public per-company jobs endpoint |

For these 5 the only non-API-key way to get real, current jobs at volume is the aggregate jobs API (fantastic.jobs - one endpoint covers all these ATS with real client data). That's a factual option, not required.

## Exact fetch-code corrections needed in discoverAuto.js

### 1. Teamtailor — replace endpoint + fields
```js
} else if (type === 'teamtailor') {
  const data = await _fetchJson(`https://${company}.teamtailor.com/jobs.json`);
  items = (data.items || []).map(j => ({
    source: 'teamtailor', job_id: `teamtailor_${company}_${j.id}`,
    title: j.title || '', company,
    url: j.url || `https://${company}.teamtailor.com`,
    location: '', description: '', posted_at: j.date_published || ''
  })).filter(j => j.title);
}
```

### 2. BambooHR — fix URL + location (jobOpeningUrl/locationCity do NOT exist)
```js
} else if (type === 'bamboohr') {
  const data = await _fetchJson(`https://${company}.bamboohr.com/careers/list`);
  items = (data.result || []).map(j => ({
    source: 'bamboohr', job_id: `bamboohr_${company}_${j.id}`,
    title: j.jobOpeningName || '', company,
    url: `https://${company}.bamboohr.com/careers/${j.id}`,
    location: j.location || '', description: '', posted_at: ''
  })).filter(j => j.title);
}
```

### 3. Personio — construct job URL (jobDescriptions does NOT exist in search.json)
```js
} else if (type === 'personio') {
  const data = await _fetchJson(`https://${company}.jobs.personio.de/search.json`);
  const arr = Array.isArray(data) ? data : (data.jobs || []);
  items = arr.map(j => ({
    source: 'personio', job_id: `personio_${company}_${j.id}`,
    title: j.name || j.title || '', company,
    url: `https://${company}.jobs.personio.de/job/${j.id}`,
    location: (Array.isArray(j.offices) && j.offices.length) ? j.offices.join(', ') : (j.office || ''),
    description: '', posted_at: j.createdAt || ''
  })).filter(j => j.title && j.id);
}
```

### 4. Recruitee — endpoint OK, fix field names (title/location/careers_url/company_name)
```js
} else if (type === 'recruitee') {
  const data = await _fetchJson(`https://${company}.recruitee.com/api/offers`);
  items = (data.offers || []).map(j => ({
    source: 'recruitee', job_id: `recruitee_${company}_${j.id}`,
    title: j.title || '', company: j.company_name || company,
    url: j.careers_url || `https://${company}.recruitee.com/o/${j.slug || j.id}`,
    location: j.location || '', description: '', posted_at: j.published_at || ''
  })).filter(j => j.title);
}
```

### 5. Breezy — add this branch (there is no branch today)
```js
} else if (type === 'breezy') {
  const data = await _fetchJson(`https://${company}.breezy.hr/json`);
  const arr = Array.isArray(data) ? data : (data.positions || []);
  items = arr.map(j => ({
    source: 'breezy', job_id: `breezy_${company}_${j.id || j.friendly_id || j.name}`,
    title: j.name || '', company: (j.company && j.company.name) || company,
    url: j.url || `https://${company}.breezy.hr`, location: (j.location && j.location.name) || '',
    description: '', posted_at: j.published_date || ''
  })).filter(j => j.title);
}
```

## Apply handlers — already routed correctly
`atsHandlerForUrl()` already routes all of these by host (greenhouse.io, jobs.lever.co, jobs.smartrecruiters.com, jobs.ashbyhq.com, apply.workable.com, recruitee.com, teamtailor.com, bamboohr.com, jobs.personio.*, breezy.hr, applytojob.com, comeet.com, jobvite.com, fountain, pinpointhq.com). The discovered job URLs from these feeds point at the real employer pages, so auto-apply will hit the correct host instead of adzuna.com.

## Geography note (no spin)
Recruitee and Personio slugs are mostly EU/UK employers (their customer bases skew Europe). BambooHR/Breezy/Teamtailor lists above skew US. If the feed must be strictly US-only, filter by location after discovery.
