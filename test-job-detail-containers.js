const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { captureJobDetails } = require('./jobDetails');
(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || '/usr/local/bin/chromium', args: ['--no-sandbox'] });
  const context = await browser.newContext();
  const duties = 'Responsibilities\n' + Array.from({ length: 35 }, (_, i) => '• Maintain accurate office record ' + i + '.').join('\n');
  const requirements = 'Requirements\nGrade 12. FINAL QUALIFICATION MARKER.';
  const posting = object => '<h1>Office Administrator</h1><script type="application/ld+json">' + JSON.stringify(object) + '</script>';
  const fixtures = {
    '/adzuna': '<h1>Office Administrator</h1><nav>PNet Create email alert</nav><section class="adp-body">' + duties.replaceAll('\n', '<br>') + '<br>' + requirements + '</section><footer>Similar jobs</footer>',
    '/split': '<h1>Office Administrator</h1><section data-at="section-text-introduction-content">Support the financial administration team.</section><section data-at="section-text-description-content">' + duties.replaceAll('\n', '<br>') + '</section><section data-at="section-text-profile-content">' + requirements + '</section>',
    '/structured': posting({ '@type': 'JobPosting', title: 'Office Administrator', description: 'A role supporting the office.', responsibilities: duties, educationRequirements: 'Grade 12', skills: 'Microsoft Excel', baseSalary: { '@type': 'MonetaryAmount', currency: 'ZAR', value: { minValue: 9000, maxValue: 12000, unitText: 'MONTH' } } }),
    '/wrong': posting({ '@type': 'JobPosting', title: 'Unrelated Developer Role', description: duties + '\n' + requirements }),
    '/truncated': posting({ '@type': 'JobPosting', title: 'Office Administrator', description: duties + '…', employmentType: 'FULL_TIME' }),
  };
  let pages = 0;
  await context.route('https://fixture.test/**', route => route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtures[new URL(route.request().url()).pathname] || '' }));
  const borrowed = { newPage: () => { pages++; return context.newPage(); } };
  try {
    const ad = await captureJobDetails('https://fixture.test/adzuna?utm_source=one', { browser: borrowed, title: 'Office Administrator' });
    assert.equal(ad.status, 'captured');
    assert(ad.description.includes('FINAL QUALIFICATION MARKER'));
    assert(!/pnet|email alert|similar jobs/i.test(ad.description));
    const previous = pages;
    await captureJobDetails('https://fixture.test/adzuna?utm_source=two', { browser: borrowed, title: 'Office Administrator' });
    assert.equal(pages, previous);
    const split = await captureJobDetails('https://fixture.test/split', { browser: borrowed, title: 'Office Administrator' });
    assert(split.description.includes('Maintain accurate office record 34'));
    assert(split.description.includes('FINAL QUALIFICATION MARKER'));
    const structured = await captureJobDetails('https://fixture.test/structured', { browser: borrowed, title: 'Office Administrator' });
    for (const fact of ['Grade 12', 'Microsoft Excel', 'ZAR 9000–12000 MONTH']) assert(structured.description.includes(fact));
    const wrong = await captureJobDetails('https://fixture.test/wrong', { browser: borrowed, title: 'Office Administrator' });
    assert.equal(wrong.description, null);
    const truncated = await captureJobDetails('https://fixture.test/truncated', { browser: borrowed, title: 'Office Administrator' });
    assert.equal(truncated.status, 'limited');
    assert.equal(context.pages().length, 0);
    console.log('PASS actual board containers, split advert sections, separate structured facts, tracking-neutral cache, wrong-job rejection, truncation detection and page cleanup');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });