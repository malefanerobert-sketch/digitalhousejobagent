const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
(async () => {
  const html = fs.readFileSync(__dirname + '/index.html', 'utf8');
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/local/bin/chromium', args: ['--no-sandbox'] });
  const page = await browser.newPage();
  try {
    await page.setContent('<div id="result"></div>');
    const helpers = html.slice(html.indexOf('const _locNorm ='), html.indexOf('const _JHB_METRO='));
    const renderer = html.slice(html.indexOf('function scopeJobSections(value){'), html.indexOf('function openJobView('));
    await page.addScriptTag({ content: 'var ZA_PROVINCES=[];var esc=s=>String(s).replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");' + helpers + renderer });
    const advert = 'Role overview\nManage collection orders.\nMinimum Requirements:\nEssential:\n• Grade 12.\nJob Specifications:\n• Prepare customer orders.\n• Keep order records.\nCompetencies:\n• Customer service.\nSpecial conditions of employment:\n• Reliable transport.\nRemuneration and benefits:\n• Market related salary.\n• Medical aid.\nONLY SUCCESSFUL APPLICANTS WILL BE CONTACTED.\nActual Employer is an equal opportunity employer.\nEmployment type: PERMANENT, FULL_TIME';
    const sections = await page.evaluate(text => scopeJobSections(text), advert);
    assert(sections.duties.includes('Prepare customer orders'));
    assert(!sections.requirements.includes('Prepare customer orders'));
    assert(sections.requirements.includes('Grade 12'));
    assert(sections.requirements.includes('Reliable transport'));
    assert(sections.salary.includes('Market related salary'));
    assert(sections.salary.includes('Medical aid'));
    assert(!sections.salary.includes('SUCCESSFUL APPLICANTS'));
    assert(!sections.salary.includes('equal opportunity'));
    assert(sections.details.includes('Recruitment policy'));
    assert(sections.details.includes('Permanent, Full-time'));
    const malformed = await page.evaluate(() => scopeJobSections('Key responsibilities:\n• Follow accounts payable processesnimum requirements:\n• Degree / Diploma in accounting.\n• Ten years of experience.'));
    assert(malformed.duties.includes('accounts payable processes'));
    assert(!malformed.duties.includes('Ten years'));
    assert(malformed.requirements.includes('Degree / Diploma'));
    assert(malformed.requirements.includes('Ten years'));
    console.log('PASS retail specifications, employment conditions, remuneration, separate policy, contact-boilerplate omission and malformed requirement-heading recovery');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });