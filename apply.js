require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
// playwright-extra + the stealth plugin were installed as dependencies but
// never actually used anywhere — every application was being submitted
// through a plain, easily-fingerprinted browser. Switching to the
// stealth-wrapped chromium here so the evasion techniques the dependency
// was added for actually run. Falls back to plain playwright if the extra
// packages are ever missing, so a bad install can't take the whole worker
// down.
let chromium;
try {
  const extra = require('playwright-extra');
  const StealthPlugin = require('puppeteer-extra-plugin-stealth');
  extra.chromium.use(StealthPlugin());
  chromium = extra.chromium;
} catch (err) {
  console.warn('[apply] stealth browser unavailable, falling back to plain Playwright:', err.message);
  chromium = require('playwright').chromium;
}
const supabase = require('./supabaseClient');
const aiMatch = require('./aiMatch');
const jobFit = require('./jobFit');
const captchaSolver = require('./captchaSolver');

const MIN_DELAY = Number(process.env.MIN_ACTION_DELAY_MS || 4000);
const MAX_DELAY = Number(process.env.MAX_ACTION_DELAY_MS || 11000);
const MAX_PER_RUN = Number(process.env.MAX_APPLICATIONS_PER_RUN || 15);
// How many pages a single watched-page application is allowed to move
// through — an initial "Apply" CTA page, then however many steps a
// multi-step form has — before giving up and reporting instead of looping
// forever on a flow it can't finish.
const MAX_FORM_STEPS = 6;

function humanDelay() {
  const ms = MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
  return new Promise(r => setTimeout(r, ms));
}

async function downloadFileToTemp(fileUrl, seekerId, tag) {
  if (!fileUrl) return null;
  const res = await fetch(fileUrl);
  if (!res.ok) throw new Error(`Failed to download ${tag} (${res.status})`);
  const ext = path.extname(new URL(fileUrl).pathname) || '.pdf';
  const tempPath = path.join(os.tmpdir(), `${tag}-${seekerId}${ext}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
}
// Kept as a thin wrapper — the 5 named-ATS functions below only ever deal
// with a single resume file input, so their call sites are unchanged.
function downloadResumeToTemp(resumeUrl, seekerId) {
  return downloadFileToTemp(resumeUrl, seekerId, 'resume');
}

function cleanupTemp(tempPath) {
  if (tempPath && fs.existsSync(tempPath)) {
    try { fs.unlinkSync(tempPath); } catch (_) { /* best effort */ }
  }
}

async function logResult(match, result, notes, evidence = {}) {
  await supabase.from('application_log').insert({
    job_match_id: match.id,
    job_seeker_id: match.job_seeker_id,
    result,
    notes,
    verification_status: evidence.verification_status || null,
    submitted_fields: evidence.submitted_fields || [],
    confirmation_text: evidence.confirmation_text || null,
    confirmation_reference: evidence.confirmation_reference || null,
    confirmation_url: evidence.confirmation_url || null,
    confirmation_screenshot_url: evidence.confirmation_screenshot_url || null
  });
  await supabase.from('job_matches')
    .update({ status: result === 'success' ? 'applied' : result, decided_at: new Date().toISOString() })
    .eq('id', match.id);
}

// A completed form is not proof of an application. Capture the values that
// were actually on the form immediately before submit, then only mark the
// application as successful when the site itself shows a receipt.
async function snapshotSubmittedFields(page) {
  return await page.evaluate(() => {
    const text = el => (el.textContent || '').replace(/\s+/g, ' ').trim();
    const labelFor = el => {
      if (el.id) {
        const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (label) return text(label);
      }
      const parent = el.closest('label');
      if (parent) return text(parent);
      return el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || 'Application field';
    };
    const sensitive = /password|identity|id number|passport|ssn|social security|tax number|bank|account number|credit.?card|debit.?card/i;
    return Array.from(document.querySelectorAll('input, select, textarea'))
      .filter(el => !el.disabled && !['hidden', 'submit', 'button', 'reset', 'image'].includes((el.type || '').toLowerCase()))
      .map(el => {
        const type = (el.type || '').toLowerCase();
        const field = labelFor(el).slice(0, 180);
        if (type === 'password') return null;
        if (type === 'file') return el.files && el.files.length ? { field, value: 'Document attached', type: 'file' } : null;
        if ((type === 'checkbox' || type === 'radio') && !el.checked) return null;
        let value = type === 'checkbox' || type === 'radio' ? 'Yes' : (el.value || '').trim();
        if (!value) return null;
        if (sensitive.test(field) || sensitive.test(el.name || '') || sensitive.test(el.id || '')) value = '[hidden for privacy]';
        return { field, value: value.slice(0, 1500), type: el.tagName.toLowerCase() };
      })
      .filter(Boolean)
      .slice(0, 60);
  }).catch(() => []);
}

function findConfirmationText(bodyText) {
  const lines = String(bodyText || '').split(/\n+/).map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  return lines.find(line => /thank you|application.{0,80}(submitted|received|complete)|we.{0,12}(received|have received).{0,80}application|submission.{0,40}(complete|successful)/i.test(line)) || null;
}

// Pull a reference / tracking number out of a confirmation page. Finds a
// keyword (application / reference / submission / tracking), then returns the
// first code-like token near it that actually contains a digit — so filler
// words ("reference", "number") are never mistaken for the code, and a
// hyphenated code like REF-2024-0098 is captured whole. Returns null when no
// real reference is shown. (The previous inline regex captured the literal
// word "reference" because its case-insensitive [A-Z0-9] also matched letters.)
function extractReference(bodyText) {
  const text = String(bodyText || '');
  const re = /(?:application|reference|submission|tracking)[^\n]{0,40}/ig;
  let m;
  // Scan EVERY keyword occurrence, not just the first — on a real confirmation
  // page the word "application" usually appears earlier (e.g. "your application
  // has been received") than the line that actually carries the reference code.
  while ((m = re.exec(text))) {
    const codes = m[0].match(/[A-Z0-9][A-Z0-9-]{3,}/gi) || [];
    for (const c of codes) {
      if (/\d/.test(c) && !/^(number|reference|application|submission|tracking)$/i.test(c)) return c;
    }
  }
  return null;
}

async function storeConfirmationScreenshot(page, match, seeker) {
  try {
    const image = await page.screenshot({ type: 'png', fullPage: false });
    const objectPath = `application-proofs/${seeker.id}/${match.id}-${Date.now()}.png`;
    const { error: uploadError } = await supabase.storage.from('documents').upload(objectPath, image, {
      contentType: 'image/png',
      upsert: false
    });
    if (uploadError) throw uploadError;
    const { data, error: signError } = await supabase.storage.from('documents').createSignedUrl(objectPath, 315360000);
    if (signError) throw signError;
    return data?.signedUrl || null;
  } catch (err) {
    // Receipt text and the source URL remain useful proof if the optional
    // screenshot upload fails; never call an unverified submission confirmed.
    console.warn('[apply] could not save confirmation screenshot:', err.message);
    return null;
  }
}

async function verifySubmission(page, match, seeker, submittedFields) {
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1200).catch(() => {});
  const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 12000)).catch(() => '');
  const confirmationText = findConfirmationText(bodyText);
  const confirmationReference = extractReference(bodyText);
  const evidence = {
    submitted_fields: submittedFields || [],
    confirmation_text: confirmationText,
    confirmation_reference: confirmationReference,
    confirmation_url: page.url()
  };

  if (!confirmationText) {
    return {
      ok: false,
      unverified: true,
      reason: 'The agent clicked Submit, but this site did not show a confirmation receipt. It is not marked as applied.',
      evidence: { ...evidence, verification_status: 'unverified' }
    };
  }

  evidence.confirmation_screenshot_url = await storeConfirmationScreenshot(page, match, seeker);
  evidence.verification_status = 'confirmed';
  return { ok: true, evidence };
}

async function submitAndVerify(page, submitBtn, missingFields, match, seeker, earlierFields = []) {
  const submittedFields = [...earlierFields, ...(await snapshotSubmittedFields(page))];
  await humanDelay();
  await submitBtn.click();
  const verification = await verifySubmission(page, match, seeker, submittedFields);
  return { ...verification, missingFields };
}

async function detectCaptcha(page) {
  return await page.$('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [class*="captcha"]');
}

// If a CAPTCHA is present, try to actually solve it via captchaSolver.js.
// That module only attempts a real solve when CAPTCHA_API_KEY is set (see
// its own ENABLED flag) — with no key configured this behaves exactly as
// before: detect, then hand off as "needs manual action". Returns null to
// mean "keep going" (no CAPTCHA found, or it was solved and injected), or
// the failure result object to return immediately when it still blocks.
async function handleCaptcha(page) {
  if (!(await detectCaptcha(page))) return null;
  const solved = await captchaSolver.solveCaptchaOnPage(page).catch(() => false);
  if (solved) return null;
  return { ok: false, reason: 'CAPTCHA detected — needs a human to solve. Handed off.', captcha: true };
}

// Figures out a human-readable label for a form field, so a missing-field
// report actually means something to the user instead of just a raw name.
async function getFieldLabel(page, field) {
  try {
    const id = await field.getAttribute('id');
    if (id) {
      const label = await page.$(`label[for="${id}"]`);
      if (label) {
        const text = (await label.textContent() || '').trim();
        if (text) return text.replace(/\*\s*$/, '').trim();
      }
    }
    const aria = await field.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    const placeholder = await field.getAttribute('placeholder');
    if (placeholder && placeholder.trim()) return placeholder.trim();
    const name = await field.getAttribute('name');
    if (name) return name;
  } catch (_) { /* best effort */ }
  return 'an unlabeled required field';
}

// Some ATS forms ask for things the CV/profile doesn't carry (e.g. work
// authorization, LinkedIn URL, a custom question). We still submit with
// what we have, but we scan for required fields left empty so the result
// can tell the user exactly what that site still needs from them.
async function findMissingRequiredFields(page, filledFields) {
  const filled = new Set((filledFields || []).filter(Boolean));
  const missing = [];
  try {
    const fields = await page.$$(
      'input[required], select[required], textarea[required], ' +
      '[aria-required="true"]'
    );
    for (const field of fields) {
      if (filled.has(field)) continue;
      const type = (await field.getAttribute('type')) || '';
      if (['file', 'hidden', 'submit', 'checkbox', 'radio', 'button'].includes(type)) continue;
      let value = '';
      try { value = await field.inputValue(); } catch (_) { /* not a value-bearing element */ }
      if (value && value.trim().length > 0) continue;
      missing.push(await getFieldLabel(page, field));
    }
  } catch (_) { /* best effort — never let this block a real submission */ }
  return missing;
}

function missingFieldsNote(missingFields) {
  if (!missingFields || missingFields.length === 0) return '';
  return ` This site also asked for: ${missingFields.join(', ')} — not covered by the CV/profile on file, so those were left blank. Please add them for this application if needed.`;
}

function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Build a clean, professional HTML CV from the fields the seeker filled in on
// their profile. This is used ONLY when the seeker has not uploaded their own
// CV file: the profile was deliberately strengthened to hold everything a
// basic CV needs, so a form that demands a document upload no longer has to
// block the whole application. Any field left blank on the profile is simply
// omitted — nothing is invented.
function buildCvHtml(seeker) {
  const S = v => (v == null ? '' : String(v).trim());
  const listOf = a => Array.isArray(a) ? a.filter(Boolean).join(', ') : S(a);
  const line = (label, val) => val ? `<tr><td class="k">${escHtml(label)}</td><td>${escHtml(val)}</td></tr>` : '';

  const name = S(seeker.full_name) || 'Candidate';
  const contact = [S(seeker.dedicated_email), S(seeker.phone), S(seeker.phone_alt)].filter(Boolean).join('&nbsp;&nbsp;•&nbsp;&nbsp;');
  const where = [S(seeker.city), S(seeker.province)].filter(Boolean).join(', ');

  const summary = S(seeker.bio) || [
    S(seeker.current_position) ? `${S(seeker.current_position)}` : '',
    (seeker.years_experience != null && seeker.years_experience !== '') ? `${seeker.years_experience} year(s) of experience` : '',
    S(seeker.highest_qualification) ? `${S(seeker.highest_qualification)}` : ''
  ].filter(Boolean).join('. ');

  const personal = [
    line('ID number', S(seeker.id_number)),
    line('Date of birth', S(seeker.date_of_birth)),
    line('Nationality', S(seeker.nationality)),
    line('Gender', S(seeker.gender)),
    line('Address', [S(seeker.physical_address), where, S(seeker.postal_code)].filter(Boolean).join(', ')),
    line("Driver's licence", listOf(seeker.drivers_license)),
    line('Own transport', seeker.own_transport === true ? 'Yes' : (seeker.own_transport === false ? 'No' : '')),
    line('Notice period', seeker.notice_period_days != null ? `${seeker.notice_period_days} day(s)` : ''),
    line('Available from', S(seeker.available_from))
  ].join('');

  const education = [
    line('Highest qualification', S(seeker.highest_qualification)),
    line('Field of study', S(seeker.field_of_study))
  ].join('');

  const experience = [
    line('Current / last position', S(seeker.current_position)),
    line('Employer', S(seeker.current_employer)),
    line('Years of experience', (seeker.years_experience != null && seeker.years_experience !== '') ? String(seeker.years_experience) : '')
  ].join('');

  const skills = listOf(seeker.skills);
  const languages = listOf(seeker.languages);
  const hobbies = S(seeker.hobbies);

  const section = (title, body) => body ? `<h2>${escHtml(title)}</h2>${body}` : '';
  const table = rows => rows ? `<table>${rows}</table>` : '';
  const para = txt => txt ? `<p>${escHtml(txt)}</p>` : '';

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font-family: 'Liberation Sans', Arial, sans-serif; color: #1a1a1a; font-size: 12px; line-height: 1.5; margin: 0; }
    .hdr { border-bottom: 2px solid #111; padding-bottom: 10px; margin-bottom: 16px; }
    .hdr h1 { margin: 0 0 4px; font-size: 24px; letter-spacing: .3px; }
    .hdr .contact { color: #333; font-size: 12px; }
    h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .6px; color: #111;
         border-bottom: 1px solid #ccc; padding-bottom: 3px; margin: 18px 0 8px; }
    table { width: 100%; border-collapse: collapse; }
    td { padding: 3px 0; vertical-align: top; }
    td.k { width: 190px; color: #555; font-weight: 600; padding-right: 12px; }
    p { margin: 0 0 6px; }
    .foot { margin-top: 22px; color: #888; font-size: 10px; border-top: 1px solid #eee; padding-top: 6px; }
  </style></head><body>
    <div class="hdr">
      <h1>${escHtml(name)}</h1>
      ${contact ? `<div class="contact">${contact}</div>` : ''}
    </div>
    ${section('Profile', para(summary))}
    ${section('Experience', table(experience))}
    ${section('Education', table(education))}
    ${section('Skills', para(skills))}
    ${section('Languages', para(languages))}
    ${section('Personal details', table(personal))}
    ${section('Interests', para(hobbies))}
    <div class="foot">Curriculum vitae generated from the candidate's JobAgent profile.</div>
  </body></html>`;
}

// Render the profile CV to a temporary PDF using the worker's existing headless
// Chromium (no extra dependency). A fresh page is opened in the same context so
// the live application form is never disturbed, and it is closed afterwards.
async function generateProfileCv(context, seeker) {
  const tempPath = path.join(os.tmpdir(), `resume-generated-${seeker.id}.pdf`);
  const pg = await context.newPage();
  try {
    await pg.setContent(buildCvHtml(seeker), { waitUntil: 'load' });
    await pg.pdf({
      path: tempPath,
      format: 'A4',
      printBackground: true,
      margin: { top: '18mm', bottom: '18mm', left: '16mm', right: '16mm' }
    });
    return tempPath;
  } finally {
    await pg.close().catch(() => {});
  }
}

async function attachResume(resumeInput, seeker) {
  if (!resumeInput) return { attached: false };

  // Preferred path: the seeker's own uploaded CV always wins.
  if (seeker.resume_url) {
    let tempResumePath = null;
    try {
      tempResumePath = await downloadResumeToTemp(seeker.resume_url, seeker.id);
      await resumeInput.setInputFiles(tempResumePath);
      await humanDelay();
      return { attached: true };
    } catch (err) {
      return { attached: false, error: `Resume attach failed: ${err.message}` };
    } finally {
      cleanupTemp(tempResumePath);
    }
  }

  // Fallback: no uploaded CV, so build one from the profile fields and attach
  // that instead of aborting the application. (Uploading a personal CV is still
  // encouraged in the app for a stronger result — this is the safety net.)
  let generatedPath = null;
  try {
    const frame = await resumeInput.ownerFrame();
    const context = frame && frame.page() ? frame.page().context() : null;
    if (!context) throw new Error('no browser context available to render the CV');
    console.log(`[apply]  ⓘ no uploaded CV for ${seeker.full_name || seeker.id} — attaching a CV generated from their profile`);
    generatedPath = await generateProfileCv(context, seeker);
    await resumeInput.setInputFiles(generatedPath);
    await humanDelay();
    return { attached: true, generated: true };
  } catch (err) {
    return { attached: false, error: `This form needs a CV file. No CV is uploaded and auto-generating one from the profile failed: ${err.message}` };
  } finally {
    cleanupTemp(generatedPath);
  }
}

// Loads the seeker's "Other documents" (ID/certificate/qualification/other —
// job_seeker_documents, uploaded from the seeker's own Documents tab) once
// per application, keyed by doc_type, most-recent-first so a re-upload wins.
async function loadSeekerDocuments(seeker) {
  const byType = {};
  const { data, error } = await supabase
    .from('job_seeker_documents')
    .select('doc_type, file_url, file_name')
    .eq('job_seeker_id', seeker.id)
    .order('created_at', { ascending: false });
  if (error || !data) return byType;
  for (const d of data) {
    if (d.doc_type && !byType[d.doc_type]) byType[d.doc_type] = d;
  }
  return byType;
}

// Attaches whichever document a file-upload field actually asked for. This
// is what makes the seeker's "Other documents" uploads (ID/certificate/
// qualification) actually reach an application, instead of only ever being
// stored and shown back to the seeker — matching what the Documents tab
// tells them ("having these on hand speeds up applications that ask for
// them"). docType 'resume' behaves exactly like attachResume(); any other
// docType looks up that seeker's most recent upload of that type. Missing a
// non-resume document is not an error — these are optional, so the field is
// just left unfilled and shows up honestly in findMissingRequiredFields.
async function attachDocument(fileInput, seeker, docType, documentsByType) {
  if (!fileInput) return { attached: false };
  if (!docType || docType === 'resume') return attachResume(fileInput, seeker);

  const doc = documentsByType?.[docType];
  if (!doc) return { attached: false }; // optional — not on file, leave the field blank

  let tempPath = null;
  try {
    tempPath = await downloadFileToTemp(doc.file_url, seeker.id, docType);
    await fileInput.setInputFiles(tempPath);
    await humanDelay();
    return { attached: true };
  } catch (err) {
    // A failed optional-document attach shouldn't sink the whole
    // application the way a missing resume does — log it as unattached.
    return { attached: false, error: null, warning: `Could not attach ${docType}: ${err.message}` };
  } finally {
    cleanupTemp(tempPath);
  }
}

// Greenhouse job pages use a fairly consistent embedded application form.
// ADMIN LOGIN — used before applying on watched-page sites that gate jobs
// behind an account. The admin registers ONCE per company; the agent uses
// that single account for every seeker's application (recruitment-agency
// pattern). This function is intentionally best-effort: no site-specific
// tricks, just find username/password/submit and try. If the form is exotic
// (SSO redirect, multi-step, requires OTP), it fails cleanly and the row
// gets marked login_status='failed' so the admin sees it.
//
// Returns { ok: true } on success, { ok: false, reason: '...' } on failure.
async function attemptAdminLogin(page, watched) {
  const loginUrl = watched.login_url || watched.career_page_url;
  if (!loginUrl) return { ok: false, reason: 'no login URL configured' };

  try {
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  } catch (err) {
    return { ok: false, reason: `could not reach login page: ${err.message}` };
  }

  // Any CAPTCHA on the login page — the same 2Captcha pipeline handles it.
  const captchaBlock = await handleCaptcha(page);
  if (captchaBlock) return { ok: false, reason: captchaBlock.reason || 'CAPTCHA on login page' };

  // Try broadly: email inputs first, then any type=text with a name/id hinting
  // at username/login. Skip anything hidden or disabled.
  const userSelectors = [
    'input[type="email"]:not([disabled])',
    'input[name*="email" i]:not([disabled])',
    'input[id*="email" i]:not([disabled])',
    'input[name*="user" i]:not([disabled])',
    'input[id*="user" i]:not([disabled])',
    'input[name*="login" i]:not([disabled])',
    'input[autocomplete="username"]',
    'input[type="text"]:not([disabled])'
  ];
  let userField = null;
  for (const sel of userSelectors) {
    userField = await page.$(sel).catch(() => null);
    if (userField) break;
  }
  if (!userField) return { ok: false, reason: 'no username/email input found on login page' };

  const passField = await page.$('input[type="password"]:not([disabled])').catch(() => null);
  if (!passField) return { ok: false, reason: 'no password input found on login page' };

  try {
    await userField.fill(watched.admin_username);
    await humanDelay();
    await passField.fill(watched.admin_password);
    await humanDelay();
  } catch (err) {
    return { ok: false, reason: `could not fill login fields: ${err.message}` };
  }

  // Prefer a submit button that lives inside the same form as the password
  // field — avoids clicking a random "Sign up" button in the page header.
  let submitBtn = await passField.evaluateHandle(el => {
    const form = el.closest('form');
    if (!form) return null;
    return form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
  });
  submitBtn = submitBtn && submitBtn.asElement ? submitBtn.asElement() : null;
  if (!submitBtn) {
    // Fallbacks — a "Sign in" / "Log in" button by visible text
    submitBtn = await page.$('button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Login"), a:has-text("Sign in")').catch(() => null);
  }
  if (!submitBtn) return { ok: false, reason: 'no submit button found on login form' };

  try {
    // Kick off both the click AND wait for either navigation OR a re-render;
    // some SPAs update in place with no full navigation.
    await Promise.race([
      Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 15000 }).catch(() => null),
        submitBtn.click()
      ]),
      page.waitForTimeout(15000)
    ]);
    await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  } catch (err) {
    return { ok: false, reason: `submit click failed: ${err.message}` };
  }

  // Post-login CAPTCHA check (sites sometimes ONLY show it after submit).
  await handleCaptcha(page);

  // Verify: still on a login page? Look for password fields or "invalid"
  // text — if we see either, the login didn't take.
  const stillHasPassword = await page.$('input[type="password"]:not([disabled])').catch(() => null);
  const bodyText = await page.evaluate(() => (document.body?.innerText || '').slice(0, 3000)).catch(() => '');
  const looksInvalid = /invalid|incorrect|wrong|failed|try again|does not match|not recognised|not recognized/i.test(bodyText);

  if (stillHasPassword && looksInvalid) {
    return { ok: false, reason: 'credentials rejected (invalid username or password)' };
  }
  if (stillHasPassword) {
    // No clear error but still a password field visible — might be a
    // multi-step form (email → password) or SSO detour. Flag it for review.
    return { ok: false, reason: 'still on a login page after submit (multi-step or SSO login?)' };
  }
  return { ok: true };
}

async function applyOnGreenhouse(page, seeker, match) {
  await page.waitForLoadState('networkidle');

  const firstName = await page.$('#first_name, input[name="job_application[first_name]"]');
  const lastName = await page.$('#last_name, input[name="job_application[last_name]"]');
  const email = await page.$('#email, input[name="job_application[email]"]');
  const resumeInput = await page.$('input[type="file"]');

  if (!firstName || !lastName || !email) {
    return { ok: false, reason: 'Could not find standard name/email fields — form layout may differ from expected.' };
  }

  const [given, ...rest] = seeker.full_name.trim().split(' ');
  const surname = rest.join(' ') || given;

  await firstName.fill(given);
  await humanDelay();
  await lastName.fill(surname);
  await humanDelay();
  await email.fill(seeker.dedicated_email || '');
  await humanDelay();

  const resumeResult = await attachResume(resumeInput, seeker);
  if (resumeResult.error) return { ok: false, reason: resumeResult.error };

  const captchaBlock = await handleCaptcha(page);
  if (captchaBlock) return captchaBlock;

  const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
  if (!submitBtn) {
    return { ok: false, reason: 'Could not find a submit button on this form.' };
  }

  const missingFields = await findMissingRequiredFields(page, [firstName, lastName, email, resumeInput]);

  return submitAndVerify(page, submitBtn, missingFields, match, seeker);
}

// Lever's hosted application forms: name="name", name="email", name="phone",
// and a resume dropzone with an underlying file input.
async function applyOnLever(page, seeker, match) {
  await page.waitForLoadState('networkidle');

  const nameField = await page.$('input[name="name"]');
  const emailField = await page.$('input[name="email"]');
  const resumeInput = await page.$('input[type="file"][name="resume"], input[type="file"]');

  if (!nameField || !emailField) {
    return { ok: false, reason: 'Could not find standard name/email fields — form layout may differ from expected.' };
  }

  await nameField.fill(seeker.full_name);
  await humanDelay();
  await emailField.fill(seeker.dedicated_email || '');
  await humanDelay();

  const phoneField = await page.$('input[name="phone"]');
  if (phoneField && seeker.phone) {
    await phoneField.fill(seeker.phone);
    await humanDelay();
  }

  const resumeResult = await attachResume(resumeInput, seeker);
  if (resumeResult.error) return { ok: false, reason: resumeResult.error };

  const captchaBlock = await handleCaptcha(page);
  if (captchaBlock) return captchaBlock;

  const submitBtn = await page.$('button[type="submit"]');
  if (!submitBtn) {
    return { ok: false, reason: 'Could not find a submit button on this form.' };
  }

  const missingFields = await findMissingRequiredFields(page, [nameField, emailField, phoneField, resumeInput]);

  return submitAndVerify(page, submitBtn, missingFields, match, seeker);
}

// SmartRecruiters hosted apply pages typically use name="firstName",
// name="lastName", name="email", and a file input for the resume/CV.
async function applyOnSmartRecruiters(page, seeker, match) {
  await page.waitForLoadState('networkidle');

  const firstName = await page.$('input[name="firstName"], #firstName');
  const lastName = await page.$('input[name="lastName"], #lastName');
  const email = await page.$('input[name="email"], #email');
  const resumeInput = await page.$('input[type="file"]');

  if (!firstName || !lastName || !email) {
    return { ok: false, reason: 'Could not find standard name/email fields — form layout may differ from expected.' };
  }

  const [given, ...rest] = seeker.full_name.trim().split(' ');
  const surname = rest.join(' ') || given;

  await firstName.fill(given);
  await humanDelay();
  await lastName.fill(surname);
  await humanDelay();
  await email.fill(seeker.dedicated_email || '');
  await humanDelay();

  const phoneField = await page.$('input[name="phoneNumber"], input[name="phone"]');
  if (phoneField && seeker.phone) {
    await phoneField.fill(seeker.phone);
    await humanDelay();
  }

  const resumeResult = await attachResume(resumeInput, seeker);
  if (resumeResult.error) return { ok: false, reason: resumeResult.error };

  const captchaBlock = await handleCaptcha(page);
  if (captchaBlock) return captchaBlock;

  const submitBtn = await page.$('button[type="submit"]');
  if (!submitBtn) {
    return { ok: false, reason: 'Could not find a submit button on this form.' };
  }

  const missingFields = await findMissingRequiredFields(page, [firstName, lastName, email, phoneField, resumeInput]);

  return submitAndVerify(page, submitBtn, missingFields, match, seeker);
}

// Ashby's hosted job application forms are React-driven; fields are usually
// exposed with name/id attributes containing "name" and "email".
async function applyOnAshby(page, seeker, match) {
  await page.waitForLoadState('networkidle');

  const nameField = await page.$('input[name*="name" i], input[id*="name" i]');
  const emailField = await page.$('input[type="email"], input[name*="email" i]');
  const resumeInput = await page.$('input[type="file"]');

  if (!nameField || !emailField) {
    return { ok: false, reason: 'Could not find standard name/email fields — form layout may differ from expected.' };
  }

  await nameField.fill(seeker.full_name);
  await humanDelay();
  await emailField.fill(seeker.dedicated_email || '');
  await humanDelay();

  const resumeResult = await attachResume(resumeInput, seeker);
  if (resumeResult.error) return { ok: false, reason: resumeResult.error };

  const captchaBlock = await handleCaptcha(page);
  if (captchaBlock) return captchaBlock;

  const submitBtn = await page.$('button[type="submit"]');
  if (!submitBtn) {
    return { ok: false, reason: 'Could not find a submit button on this form.' };
  }

  const missingFields = await findMissingRequiredFields(page, [nameField, emailField, resumeInput]);

  return submitAndVerify(page, submitBtn, missingFields, match, seeker);
}

// Workable's hosted apply forms typically use name="candidate[name]" or
// separate first/last name fields, plus name="candidate[email]".
async function applyOnWorkable(page, seeker, match) {
  await page.waitForLoadState('networkidle');

  const fullNameField = await page.$('input[name="candidate[name]"]');
  const firstName = await page.$('input[name="candidate[firstname]"]');
  const lastName = await page.$('input[name="candidate[lastname]"]');
  const emailField = await page.$('input[name="candidate[email]"], input[type="email"]');
  const resumeInput = await page.$('input[type="file"]');

  if (!emailField || (!fullNameField && (!firstName || !lastName))) {
    return { ok: false, reason: 'Could not find standard name/email fields — form layout may differ from expected.' };
  }

  if (fullNameField) {
    await fullNameField.fill(seeker.full_name);
    await humanDelay();
  } else {
    const [given, ...rest] = seeker.full_name.trim().split(' ');
    const surname = rest.join(' ') || given;
    await firstName.fill(given);
    await humanDelay();
    await lastName.fill(surname);
    await humanDelay();
  }

  await emailField.fill(seeker.dedicated_email || '');
  await humanDelay();

  const resumeResult = await attachResume(resumeInput, seeker);
  if (resumeResult.error) return { ok: false, reason: resumeResult.error };

  const captchaBlock = await handleCaptcha(page);
  if (captchaBlock) return captchaBlock;

  const submitBtn = await page.$('button[type="submit"]');
  if (!submitBtn) {
    return { ok: false, reason: 'Could not find a submit button on this form.' };
  }

  const missingFields = await findMissingRequiredFields(page, [fullNameField, firstName, lastName, emailField, resumeInput]);

  return submitAndVerify(page, submitBtn, missingFields, match, seeker);
}

// Reads EVERY input/select/textarea actually present on the page — not a
// guess off a fixed list of common names — so an AI model can work out what
// each one is for, however it's labelled. Tags each element with a
// data-agent-idx attribute so the mapping AI returns can be matched back to
// a real element afterwards.
async function extractFormFields(page) {
  return await page.evaluate(() => {
    const els = Array.from(document.querySelectorAll('input, select, textarea'));
    return els.map((el, i) => {
      el.setAttribute('data-agent-idx', String(i));
      let label = '';
      if (el.id) {
        const l = document.querySelector(`label[for="${el.id}"]`);
        if (l) label = l.textContent.trim();
      }
      if (!label) {
        const parentLabel = el.closest('label');
        if (parentLabel) label = parentLabel.textContent.trim();
      }
      const options = el.tagName === 'SELECT'
        ? Array.from(el.options).slice(0, 40).map(o => o.textContent.trim() || o.value)
        : undefined;
      return {
        idx: i,
        tag: el.tagName.toLowerCase(),
        type: el.type || null,
        name: el.name || null,
        id: el.id || null,
        placeholder: el.placeholder || null,
        ariaLabel: el.getAttribute('aria-label') || null,
        label: label || null,
        required: !!(el.required || el.getAttribute('aria-required') === 'true'),
        options
      };
    }).filter(f => !['hidden', 'submit', 'button', 'image', 'password'].includes(f.type));
  });
}

function buildFieldMappingPrompt(fields, seeker, documentsByType) {
  // Full profile — soft fields included so the agent can compose short answers
  // to open-ended application questions when the user has enabled autofill.
  const profile = {
    // hard identity — never inventable
    full_name: seeker.full_name,
    email: seeker.dedicated_email,
    phone: seeker.phone || null,
    phone_alt: seeker.phone_alt || null,
    date_of_birth: seeker.date_of_birth || null,
    gender: seeker.gender || null,
    race: seeker.race || null,
    id_type: seeker.id_type || null,
    id_number: seeker.id_number || null,
    nationality: seeker.nationality || null,
    physical_address: seeker.physical_address || null,
    city: seeker.city || null,
    province: seeker.province || null,
    postal_code: seeker.postal_code || null,

    // work + preferences — hard
    job_titles: seeker.job_title_keywords || [],
    preferred_locations: seeker.preferred_locations || [],
    salary_min: seeker.salary_min || null,
    salary_max: seeker.salary_max || null,
    current_employer: seeker.current_employer || null,
    current_position: seeker.current_position || null,
    years_experience: seeker.years_experience || null,
    highest_qualification: seeker.highest_qualification || null,
    field_of_study: seeker.field_of_study || null,
    skills: seeker.skills || [],
    languages: seeker.languages || [],
    drivers_license: seeker.drivers_license || [],
    own_transport: seeker.own_transport,
    willing_to_relocate: seeker.willing_to_relocate,
    notice_period_days: seeker.notice_period_days || null,
    available_from: seeker.available_from || null,

    // soft — the agent may compose from these + the rest of the profile
    bio: seeker.bio || null,
    hobbies: seeker.hobbies || null,
    pressure_ok: seeker.pressure_ok,
    team_player: seeker.team_player,

    has_resume_file: !!seeker.resume_url,
    // Other documents the seeker has actually uploaded on their Documents
    // tab (optional, so this list may be empty or partial) — only these
    // exact types can be attached; never claim one that isn't listed here.
    available_documents: Object.keys(documentsByType || {}),
  };
  // Default TRUE — the user has to explicitly opt out in profile settings.
  const canAutofillSoft = seeker.agent_can_autofill_soft !== false;

  return `You are helping fill out a job application form automatically for a candidate, on an unfamiliar page whose layout you've never seen before. Below is the candidate's profile and every input/select/textarea field found on the page (each tagged with an "idx" — reference that, not name/id).

CANDIDATE PROFILE:
${JSON.stringify(profile)}

FORM FIELDS:
${JSON.stringify(fields)}

Decide what to do with each field that's clearly answerable from the profile, and reply with a JSON array of entries, using ONLY these shapes:
- Text/email/tel/textarea field: {"idx": <n>, "action": "fill", "value": "<text>"}
- A <select> dropdown: {"idx": <n>, "action": "select", "value": "<the closest matching option text>"}
- A checkbox that should be ticked (e.g. a consent/terms/"I agree" checkbox that's required to submit): {"idx": <n>, "action": "check", "value": true}
- A radio button that should be selected: {"idx": <n>, "action": "check", "value": true}
- A file-upload field meant for a resume/CV: {"idx": <n>, "action": "file", "docType": "resume"}
- A file-upload field asking for an ID document, certificate, qualification, or other supporting document: {"idx": <n>, "action": "file", "docType": "id"|"certificate"|"qualification"|"other"} — ONLY when that exact type appears in available_documents; if the field asks for a document type not in available_documents, omit the field entirely rather than guessing another type

Rules for HARD FACTS — never invent these, leave the field out if the profile doesn't have it:
- Names, contact details, email, phone
- Employment history, employer names, positions, dates, years of experience beyond what the profile states
- Education, qualifications, institutions
- ID / passport numbers, addresses, DOB, nationality
- LinkedIn / GitHub / portfolio URLs
- Salary expectations beyond the min/max range on the profile
- Work-authorization / visa status
- Anything the profile doesn't directly state
${canAutofillSoft ? `
Rules for SOFT / SUBJECTIVE questions — you MAY compose short, authentic-sounding answers from the profile when the field asks for one and the direct answer isn't on the profile:
- "Tell us about yourself" / short bio → use the "bio" field verbatim if present; otherwise write 2-3 sentences synthesised from job_titles, current_position, years_experience, skills, highest_qualification. First person, warm but professional.
- "Why this role?" / motivation / cover-letter-style prompt → 3-5 sentences tying the candidate's job_titles / skills / current_position to what the role obviously needs. Do not name the company unless it's referenced elsewhere in the form fields. Never claim specific past achievements the profile doesn't list.
- "Can you work under pressure?" / "Do you handle stress well?" → use pressure_ok if set (true → "Yes"); if not set, answer "Yes" with a brief one-line reason drawn from current_position / years_experience.
- "Are you a team player?" / "Do you work well in a team?" → use team_player if set (true → "Yes"); otherwise "Yes" with a one-line reason.
- Hobbies / interests → use "hobbies" verbatim if present; otherwise omit rather than invent.
- "When can you start?" → use available_from if set, otherwise notice_period_days ("Available in <N> days"); otherwise "Immediately" only if notice_period_days is 0 or null.
- "Willing to relocate?" / "Own transport?" / "Driver's licence?" → answer from the corresponding profile fields.

For a soft answer you compose: keep it concise (a short paragraph max for open textareas, one sentence for short-answer inputs), first person, plain language, no clichés like "team player" or "hard worker", no fabricated numbers, no fabricated employer / project / school names.
` : `
The candidate has opted OUT of soft-field autofill. Treat soft/subjective questions the same as hard facts — omit the field rather than compose an answer.
`}
Never touch a password field. If a field is a hard fact not on the profile — and it's not a soft field you're allowed to compose — omit it. Leaving something blank is better than making it up.

Reply with ONLY a JSON array, no other text. If nothing on this page is fillable from this profile, reply with exactly: []`;
}

async function fillFieldsWithAI(page, fields, mapping) {
  const filledEls = [];
  for (const m of mapping) {
    if (!m || typeof m.idx !== 'number') continue;
    const field = fields.find(f => f.idx === m.idx);
    if (!field) continue;
    const el = await page.$(`[data-agent-idx="${m.idx}"]`);
    if (!el) continue;
    try {
      if (m.action === 'select') {
        await el.selectOption({ label: String(m.value) }).catch(() => el.selectOption(String(m.value)).catch(() => {}));
      } else if (m.action === 'check') {
        if (m.value) await el.check().catch(() => {});
      } else if (m.action === 'fill' && field.tag !== 'select') {
        await el.fill(String(m.value ?? '')).catch(() => {});
      } else {
        continue;
      }
      filledEls.push(el);
      await humanDelay();
    } catch (_) { /* best effort — one bad field shouldn't sink the whole application */ }
  }
  return filledEls;
}

// The AI-driven filler for watched-page postings: reads whatever form is
// actually on the page (any layout, any field names/labels/language) and
// asks the shared AI model to map fields to the candidate's profile, rather
// than guessing off a fixed list of common selectors — this is what lets the
// Agent handle "any type of form", not just the 5 known ATS platforms above.
//
// This is the FULL flow end to end, not just one form: many real career
// pages show a job description first with just an "Apply"/"Apply now"
// button, and the actual form only appears after clicking it (sometimes as
// a modal, sometimes a whole new page) — findApplyEntryPoint() finds and
// clicks through that. And a form itself is often multiple steps (fill
// step 1 -> click Next -> more fields appear -> fill step 2 -> ... ->
// Submit) — the loop below re-scans the page after every click and keeps
// going as long as there's still something to fill or click, up to
// MAX_FORM_STEPS pages, rather than stopping after a single pass.
async function findApplyEntryPoint(page) {
  return await page.$(
    'a:has-text("Apply now"), a:has-text("Apply Now"), a:has-text("Apply"), ' +
    'button:has-text("Apply now"), button:has-text("Apply Now"), button:has-text("Apply"), ' +
    'a:has-text("Start application"), button:has-text("Start application"), ' +
    'a:has-text("Start Application"), button:has-text("Start Application")'
  );
}

// Decides what to click to move forward on the current step. A Next/
// Continue button means there's more of the form still to come (loop
// again after clicking); a Submit/Apply/Send button means this is the last
// step (return success after clicking it).
async function findStepButton(page) {
  const nextBtn = await page.$(
    'button:has-text("Next"), a:has-text("Next"), button:has-text("Continue"), a:has-text("Continue"), ' +
    'button:has-text("Proceed"), a:has-text("Proceed"), button:has-text("Continue application"), ' +
    '[role="button"]:has-text("Next"), [role="button"]:has-text("Continue")'
  );
  if (nextBtn) return { el: nextBtn, isFinal: false };
  const submitBtn = await page.$(
    'button[type="submit"], input[type="submit"], ' +
    // input[type="button"] carrying an apply/submit-like value is a common
    // hand-rolled submit control that the previous selector missed entirely.
    'input[type="button"][value*="Submit" i], input[type="button"][value*="Apply" i], ' +
    'input[type="button"][value*="Send" i], input[type="button"][value*="Finish" i], ' +
    // A <button> inside a <form> with NO type attribute is an IMPLICIT
    // submit button per the HTML spec — the selector above only matched an
    // explicit type="submit", so plenty of real forms (anything hand-rolled
    // or built without setting type= on its button) were silently invisible
    // to this function, surfacing as "couldn't find a Next or Submit
    // button" even though a perfectly normal submit button was right there.
    // Back/Previous/Cancel buttons are excluded so a multi-step form's
    // "back" control (also often untyped) doesn't get misidentified as the
    // final submit action.
    'form button:not([type="button"]):not([type="reset"]):not(:has-text("Back")):not(:has-text("Previous")):not(:has-text("Cancel")), ' +
    'button:has-text("Submit"), button:has-text("Apply"), button:has-text("Send"), ' +
    'button:has-text("Finish"), button:has-text("Complete"), button:has-text("Confirm"), ' +
    'button:has-text("Save and continue"), button:has-text("Review application"), ' +
    // Match on accessibility labels too — icon-only or styled buttons often
    // carry their meaning in aria-label rather than visible text.
    '[role="button"]:has-text("Submit"), [role="button"]:has-text("Apply"), ' +
    '[aria-label*="Submit" i], [aria-label*="Apply" i], ' +
    'a:has-text("Submit application"), a:has-text("Submit Application")'
  );
  if (submitBtn) {
    // Styled/custom buttons are often off-screen until scrolled to; make sure
    // the element is in view so the subsequent click actually lands.
    await submitBtn.scrollIntoViewIfNeeded().catch(() => {});
    return { el: submitBtn, isFinal: true };
  }
  return null;
}

// Loose-selector guess used within a single step of the loop below, when AI
// mapping isn't configured or comes back empty for that particular page —
// fills what it can find rather than aborting the whole multi-step flow
// over one page's worth of trouble. Only fills; the loop itself decides
// what to click next.
async function fillGenericStep(page, seeker) {
  const nameField = await page.$('input[name*="name" i]:not([name*="user" i]):not([type="email"]), input[id*="name" i]:not([id*="user" i]), input[placeholder*="full name" i], input[placeholder*="your name" i]');
  const emailField = await page.$('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]');
  const phoneField = await page.$('input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[placeholder*="phone" i]');
  const resumeInput = await page.$('input[type="file"]');

  if (!nameField && !emailField && !resumeInput) {
    return { ok: false, reason: 'could not find recognizable name/email/resume fields on this step', filledEls: [] };
  }

  const filledEls = [];
  if (nameField) { await nameField.fill(seeker.full_name); await humanDelay(); filledEls.push(nameField); }
  if (emailField) { await emailField.fill(seeker.dedicated_email || ''); await humanDelay(); filledEls.push(emailField); }
  if (phoneField && seeker.phone) { await phoneField.fill(seeker.phone); await humanDelay(); filledEls.push(phoneField); }

  if (resumeInput) {
    const resumeResult = await attachResume(resumeInput, seeker);
    if (resumeResult.error) return { ok: false, reason: resumeResult.error, filledEls: [] };
    filledEls.push(resumeInput);
  }

  return { ok: true, filledEls };
}

async function applyAI(page, seeker, match) {
  let lastMissingFields = [];
  const earlierFields = [];
  const documentsByType = await loadSeekerDocuments(seeker);

  for (let step = 0; step < MAX_FORM_STEPS; step++) {
    await page.waitForLoadState('networkidle').catch(() => {});

    const captchaBlock = await handleCaptcha(page);
    if (captchaBlock) return captchaBlock;

    const fields = await extractFormFields(page);

    if (!fields.length) {
      // No form visible yet on this page — look for an "Apply" CTA that
      // reveals the real form (job-description-first career pages).
      const entry = await findApplyEntryPoint(page);
      if (!entry) {
        return {
          ok: false,
          reason: step === 0
            ? 'No form fields found on this page at all — this doesn\'t look like a real application form.'
            : `Got ${step} step(s) into this application, then reached a page with no form and no "Apply" button to continue — needs a human to finish.`
        };
      }
      await entry.click().catch(() => {});
      await humanDelay();
      continue; // re-scan whatever we land on next
    }

    let mapping = [];
    const aiOverride = aiMatch.resolveSeekerOverride(seeker);
    // A seeker set to 'none' opted out of AI entirely — never fall back to
    // the shared company key for them, even though one may be configured.
    if (seeker.api_provider !== 'none' && (aiMatch.isEnabled() || aiOverride)) {
      const raw = await aiMatch.completeWithAI(buildFieldMappingPrompt(fields, seeker, documentsByType), aiOverride);
      if (raw) {
        try {
          const cleaned = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
          const parsed = JSON.parse(cleaned);
          if (Array.isArray(parsed)) mapping = parsed;
        } catch (_) { /* fall through to the loose fallback below */ }
      }
    }

    let filledEls;
    if (mapping.length) {
      filledEls = await fillFieldsWithAI(page, fields, mapping);
      // A form can ask for more than one file (resume + ID + certificate,
      // say) — attach every file-type field the mapping identified, not
      // just the first, so uploaded documents actually reach forms that
      // ask for them.
      const fileFieldMaps = mapping.filter(m => m && m.action === 'file');
      for (const fileMap of fileFieldMaps) {
        const fileEl = await page.$(`[data-agent-idx="${fileMap.idx}"]`);
        const attachResult = await attachDocument(fileEl, seeker, fileMap.docType, documentsByType);
        // Only a missing/failed RESUME sinks the application — a missing or
        // failed optional document (ID/certificate/qualification) doesn't,
        // since the seeker never had to upload those in the first place.
        if (attachResult.error) return { ok: false, reason: attachResult.error };
        if (fileEl && attachResult.attached) filledEls.push(fileEl);
      }
    } else {
      const loose = await fillGenericStep(page, seeker);
      if (!loose.ok) {
        return {
          ok: false,
          reason: step === 0 ? loose.reason : `Got ${step} step(s) into this application, then ${loose.reason} — needs a human to finish.`
        };
      }
      filledEls = loose.filledEls;
    }

    if (!filledEls.length && step === 0) {
      return { ok: false, reason: 'This page\'s application form doesn\'t look like a standard job application — could not find recognizable fields to fill.' };
    }

    lastMissingFields = await findMissingRequiredFields(page, filledEls);

    const stepBtn = await findStepButton(page);
    if (!stepBtn) {
      return { ok: false, reason: `Got ${step + 1} step(s) into this application but couldn't find a Next or Submit button to continue — needs a human to finish.` };
    }

    if (stepBtn.isFinal) {
      return submitAndVerify(page, stepBtn.el, lastMissingFields, match, seeker, earlierFields);
    }
    earlierFields.push(...(await snapshotSubmittedFields(page)));
    await humanDelay();
    await stepBtn.el.click().catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});
    // else: a Next/Continue step — loop back around and handle whatever it reveals
  }

  return { ok: false, reason: `This application needed more than ${MAX_FORM_STEPS} steps to complete — handed off for manual review rather than risk submitting something wrong halfway through.` };
}

async function run() {
  console.log(`[apply] starting run at ${new Date().toISOString()}`);

  await aiMatch.loadSettings(supabase);

  if (!aiMatch.isAgentEnabled()) {
    console.log('[apply] Agent master switch is OFF (dispatch_settings.agent_enabled=false) — skipping this run, nothing will be applied to.');
    return;
  }

  const { data: pending, error } = await supabase
    .from('job_matches')
    .select('*, job_seekers(*), job_sources(*), job_custom_sources(*)')
    .in('status', ['approved', 'pending'])
    // watched/custom-source postings now go through the same auto-apply
    // attempt as any other source — they only land in the user's
    // application report if the agent actually can't submit them.
    .order('status', { ascending: true })
    .limit(MAX_PER_RUN * 3);

  if (error) { console.error('[apply] failed to load job_matches:', error.message); return; }
  if (!pending || pending.length === 0) { console.log('[apply] nothing to process'); return; }

  // Don't keep retrying a posting that already hit a structural wall (a
  // CAPTCHA, or a form layout the agent doesn't recognize) — that won't
  // change on a retry, and retrying it anyway is what was piling up long
  // runs of duplicate entries for the same company in the application
  // report. This is checked independently of job_matches.status so it
  // holds even if a match gets re-queued as pending/approved later.
  const seekerIds = [...new Set(pending.map(m => m.job_seeker_id).filter(Boolean))];
  const { data: terminalLogs } = await supabase
    .from('application_log')
    .select('job_seeker_id, job_matches(job_url)')
    .in('job_seeker_id', seekerIds)
    .in('result', ['captcha_blocked', 'needs_manual_action']);
  const alreadyTerminal = new Set(
    (terminalLogs || [])
      .filter(l => l.job_matches?.job_url)
      .map(l => `${l.job_seeker_id}|${l.job_matches.job_url}`)
  );

  const titleSkips = []; // pending rows above the seeker's level: marked 'skipped' (still visible in Matches)
  const toProcess = pending.filter(m => {
    // An 'approved' row means the user pressed Apply on the Matches card — an
    // explicit decision that overrides the location / level guards below.
    const userForced = m.status === 'approved';
    // Respect paused/frozen accounts — admin can pause an account and the
    // worker must stop processing pending matches for it, otherwise it keeps
    // burning tokens on someone whose account has been switched off.
    if (!m.job_seekers || m.job_seekers.status !== 'active') return false;
    const blockedCompanies = m.job_seekers?.blocked_companies || [];
    const isBlockedCompany = blockedCompanies.some(b => b.toLowerCase() === (m.company_name || '').toLowerCase());
    if (isBlockedCompany) return false;
    const blockedLocations = m.job_seekers?.blocked_locations || [];
    const isBlockedLocation = blockedLocations.some(loc => (m.location || '').toLowerCase().includes(loc.toLowerCase()));
    if (isBlockedLocation) return false;

    // APPLY-SCOPE LOCATION FILTER
    // ---------------------------
    // Discovery is intentionally national — every match a seeker could care
    // about is still saved to job_matches and shown in their Matches view.
    // Apply-scope, on the other hand, is what the seeker actually picked in
    // Profile > Preferred locations: if they narrowed it to specific cities,
    // the agent must NOT auto-apply to jobs outside that set (matches from
    // other cities stay pending and simply aren't attempted).
    //
    // Sentinel handling: [] or ['All locations'] both mean "no narrowing —
    // apply anywhere". Any other array is a real narrow list, matched with a
    // case-insensitive substring test so "Johannesburg" catches
    // "Johannesburg, ZA" / "Johannesburg, Gauteng" / etc. When the seeker
    // later switches back to All locations, the previously-skipped rows are
    // still status='pending' (this filter never mutates status), so they get
    // picked up on the very next apply run — that IS the "revisit past
    // matches" behaviour Preferred locations promises in the UI.
    const preferredLocs = m.job_seekers?.preferred_locations || [];
    const scopeIsAll =
      preferredLocs.length === 0 ||
      (preferredLocs.length === 1 && preferredLocs[0] === 'All locations');
    if (!scopeIsAll) {
      // Alias-aware: "Johannesburg" and "Gauteng" (plus Johannesburg-metro
      // suburbs like Sandton/Midrand/Randburg) count as the same place.
      if (!userForced && !jobFit.locationInScope(m.location, preferredLocs)) return false;
    }

    // LEVEL GUARD: never auto-apply to roles above the seeker's qualification
    // (engineer / architect / scientist / senior / lead…). The row stays as it
    // is; it just isn't attempted.
    if (!userForced) {
      const why = jobFit.titleSkipReason(m.job_title, m.job_seekers);
      if (why) { titleSkips.push({ id: m.id, msg: jobFit.skipMessage(why) }); return false; }
    }

    if (alreadyTerminal.has(`${m.job_seeker_id}|${m.job_url}`)) return false;
    return m.status === 'approved' || (m.status === 'pending' && m.job_seekers?.application_mode === 'automatic');
  }).slice(0, MAX_PER_RUN);

  // Keep skipped jobs visible: status 'skipped' + a reason the Matches card shows.
  // The user can press Apply on the card, which sets status='approved' (queued).
  for (const t of titleSkips) {
    await supabase.from('job_matches').update({ status: 'skipped', skip_reason: t.msg, decided_at: new Date().toISOString() }).eq('id', t.id);
  }
  if (titleSkips.length) console.log(`[apply] ${titleSkips.length} job(s) above the seeker's level marked 'skipped' (still visible in Matches)`);

  if (toProcess.length === 0) { console.log('[apply] no approved/automatic matches ready'); return; }

  const browser = await chromium.launch({ headless: true });

  for (const match of toProcess) {
    const seeker = match.job_seekers;
    const source = match.job_sources;
    console.log(`[apply] processing "${match.job_title}" @ ${match.company_name} for ${seeker.full_name}`);

    // A crashed Chromium renderer ("Target crashed" / "Page crashed") is a
    // transient resource hiccup in this container, not a real problem with
    // the posting — the same URL usually works fine on a fresh page. Retry
    // once with a brand-new context/page before giving up, instead of
    // immediately logging a permanent 'failed' result for something that
    // had nothing to do with the actual application.
    let lastErr = null;
    let attempted = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        // ADMIN-CREDENTIAL LOGIN (watched pages only)
        // -----------------------------------------
        // Some employer sites require an account to view jobs or submit the
        // application form. Admin registers ONCE per company (recruitment-
        // agency pattern) and stores creds on job_custom_sources; the agent
        // uses the same login for every seeker's application. If the login
        // fails, the row is marked needs_manual_action + login_status='failed'
        // and the admin sees it in the Companies tab pill.
        const watched = match.job_custom_sources;
        if (watched && watched.admin_username && watched.admin_password) {
          const loginRes = await attemptAdminLogin(page, watched);
          if (!loginRes.ok) {
            console.log(`[apply]  ✖ admin login failed for "${watched.company_name}": ${loginRes.reason}`);
            await supabase.from('job_custom_sources').update({
              login_status: 'failed',
              login_last_error: loginRes.reason,
              last_login_at: new Date().toISOString()
            }).eq('id', watched.id);
            await logResult(match, 'needs_manual_action', `Admin login failed for ${watched.company_name}: ${loginRes.reason}. Check credentials in admin → Companies.`);
            attempted = true;
            await context.close().catch(() => {});
            break;
          }
          // Success — record it and continue to the job URL in the SAME context
          // so the session cookie is carried across.
          await supabase.from('job_custom_sources').update({
            login_status: 'ok',
            login_last_error: null,
            last_login_at: new Date().toISOString()
          }).eq('id', watched.id);
          console.log(`[apply]  🔓 logged in to "${watched.company_name}" as ${watched.admin_username}`);
        }

        await page.goto(match.job_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await humanDelay();

        // REQUIREMENTS CHECK: read the ad and skip it if it clearly asks for
        // more than the seeker has (qualification level, years of experience,
        // mandatory technical skills). Fails open — an unreadable page or an
        // unavailable AI never blocks an application. A rejected match is NOT
        // a "needs your input" case (nothing a human could do), so it is
        // marked 'rejected' and simply drops out of Matches and Applications.
        if (match.status !== 'approved' && seeker.api_provider !== 'none' && (aiMatch.isEnabled() || aiMatch.resolveSeekerOverride(seeker))) {
          const adText = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
          const override = aiMatch.resolveSeekerOverride(seeker);
          const fit = await jobFit.checkRequirements({
            seeker, title: match.job_title, adText,
            complete: (prompt) => aiMatch.completeWithAI(prompt, override)
          });
          if (!fit.ok) {
            console.log(`[apply]  ⏭ skipping "${match.job_title}" — ${fit.reason}`);
            await supabase.from('job_matches').update({
              status: 'skipped',
              skip_reason: jobFit.skipMessage(fit.reason),
              decided_at: new Date().toISOString()
            }).eq('id', match.id);
            attempted = true;
            break;
          }
        }

        let result;
        if (source?.source_type === 'greenhouse') {
          result = await applyOnGreenhouse(page, seeker, match);
        } else if (source?.source_type === 'lever') {
          result = await applyOnLever(page, seeker, match);
        } else if (source?.source_type === 'smartrecruiters') {
          result = await applyOnSmartRecruiters(page, seeker, match);
        } else if (source?.source_type === 'ashby') {
          result = await applyOnAshby(page, seeker, match);
        } else if (source?.source_type === 'workable') {
          result = await applyOnWorkable(page, seeker, match);
        } else {
          // Everything else — watched pages AND autonomous-search postings
          // (Adzuna/RemoteOK/Jobmail, which have no job_sources row and
          // aren't is_custom_source) — goes through the same AI-driven form
          // filler. It was previously gated to is_custom_source only, which
          // meant every autonomously-discovered job structurally could never
          // be applied to and always landed in needs_manual_action. applyAI()
          // was built to handle "any layout it's never seen before", which is
          // exactly what an arbitrary job-board posting is.
          result = await applyAI(page, seeker, match);
        }

        const formLabel = source?.source_type || (match.is_custom_source ? 'watched-page' : 'job-board');

        if (result.ok) {
          const note = missingFieldsNote(result.missingFields);
          console.log(`[apply]  ✔ submitted${note ? ' (some info still needed)' : ''}`);
          await logResult(match, 'success', `Confirmed by the job site via ${formLabel} form automation.${note}`, result.evidence);
        } else if (result.unverified) {
          console.log(`[apply]  ⚠ submit was not verified by the site`);
          await logResult(match, 'submission_unverified', result.reason, result.evidence);
        } else if (result.captcha) {
          console.log(`[apply]  ⚠ captcha — needs manual action`);
          await logResult(match, 'captcha_blocked', result.reason);
        } else {
          console.log(`[apply]  ✖ ${result.reason}`);
          await logResult(match, 'needs_manual_action', result.reason);
        }
        attempted = true;
      } catch (err) {
        lastErr = err;
        const isCrash = /crashed/i.test(err.message || '');
        if (isCrash && attempt === 1) {
          console.warn(`[apply]  ⚠ browser tab crashed on attempt 1 (${err.message}) — retrying once with a fresh page`);
        } else {
          const isNetworkIssue = /net::|ERR_|timeout|ENOTFOUND|EAI_AGAIN/i.test(err.message || '');
          const note = isNetworkIssue
            ? `This posting's link appears broken, mistyped, or no longer exists (${err.message}).`
            : (isCrash ? `The browser crashed twice trying to load/process this posting (${err.message}).` : err.message);
          console.error(`[apply]  ✖ ${isNetworkIssue ? 'broken link' : (isCrash ? 'repeated crash' : 'error')}:`, err.message);
          await logResult(match, isNetworkIssue ? 'needs_manual_action' : 'failed', note);
          attempted = true;
        }
      } finally {
        await context.close().catch(() => {}); // a crashed target can make close() itself throw — never let cleanup sink the run
      }
      if (attempted) break;
    }

    await humanDelay();
  }

  await browser.close();
  console.log('[apply] run complete');
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
