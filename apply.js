require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const supabase = require('./supabaseClient');

const MIN_DELAY = Number(process.env.MIN_ACTION_DELAY_MS || 4000);
const MAX_DELAY = Number(process.env.MAX_ACTION_DELAY_MS || 11000);
const MAX_PER_RUN = Number(process.env.MAX_APPLICATIONS_PER_RUN || 15);

function humanDelay() {
  const ms = MIN_DELAY + Math.random() * (MAX_DELAY - MIN_DELAY);
  return new Promise(r => setTimeout(r, ms));
}

async function downloadResumeToTemp(resumeUrl, seekerId) {
  if (!resumeUrl) return null;
  const res = await fetch(resumeUrl);
  if (!res.ok) throw new Error(`Failed to download resume (${res.status})`);
  const ext = path.extname(new URL(resumeUrl).pathname) || '.pdf';
  const tempPath = path.join(os.tmpdir(), `resume-${seekerId}${ext}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(tempPath, buffer);
  return tempPath;
}

function cleanupTemp(tempPath) {
  if (tempPath && fs.existsSync(tempPath)) {
    try { fs.unlinkSync(tempPath); } catch (_) { /* best effort */ }
  }
}

async function logResult(match, result, notes) {
  await supabase.from('application_log').insert({
    job_match_id: match.id,
    job_seeker_id: match.job_seeker_id,
    result,
    notes
  });
  await supabase.from('job_matches')
    .update({ status: result === 'success' ? 'applied' : result, decided_at: new Date().toISOString() })
    .eq('id', match.id);
}

async function detectCaptcha(page) {
  return await page.$('iframe[src*="recaptcha"], iframe[src*="hcaptcha"], [class*="captcha"]');
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

async function attachResume(resumeInput, seeker) {
  if (!resumeInput) return { attached: false };
  if (!seeker.resume_url) {
    return { attached: false, error: 'This form requires a resume file, but this seeker has no resume_url on record.' };
  }
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

// Greenhouse job pages use a fairly consistent embedded application form.
async function applyOnGreenhouse(page, seeker) {
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

  if (await detectCaptcha(page)) {
    return { ok: false, reason: 'CAPTCHA detected — needs a human to solve. Handed off.', captcha: true };
  }

  const submitBtn = await page.$('button[type="submit"], input[type="submit"]');
  if (!submitBtn) {
    return { ok: false, reason: 'Could not find a submit button on this form.' };
  }

  const missingFields = await findMissingRequiredFields(page, [firstName, lastName, email, resumeInput]);

  await humanDelay();
  await submitBtn.click();
  await page.waitForLoadState('networkidle');

  return { ok: true, missingFields };
}

// Lever's hosted application forms: name="name", name="email", name="phone",
// and a resume dropzone with an underlying file input.
async function applyOnLever(page, seeker) {
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

  if (await detectCaptcha(page)) {
    return { ok: false, reason: 'CAPTCHA detected — needs a human to solve. Handed off.', captcha: true };
  }

  const submitBtn = await page.$('button[type="submit"]');
  if (!submitBtn) {
    return { ok: false, reason: 'Could not find a submit button on this form.' };
  }

  const missingFields = await findMissingRequiredFields(page, [nameField, emailField, phoneField, resumeInput]);

  await humanDelay();
  await submitBtn.click();
  await page.waitForLoadState('networkidle');

  return { ok: true, missingFields };
}

// SmartRecruiters hosted apply pages typically use name="firstName",
// name="lastName", name="email", and a file input for the resume/CV.
async function applyOnSmartRecruiters(page, seeker) {
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

  if (await detectCaptcha(page)) {
    return { ok: false, reason: 'CAPTCHA detected — needs a human to solve. Handed off.', captcha: true };
  }

  const submitBtn = await page.$('button[type="submit"]');
  if (!submitBtn) {
    return { ok: false, reason: 'Could not find a submit button on this form.' };
  }

  const missingFields = await findMissingRequiredFields(page, [firstName, lastName, email, phoneField, resumeInput]);

  await humanDelay();
  await submitBtn.click();
  await page.waitForLoadState('networkidle');

  return { ok: true, missingFields };
}

// Ashby's hosted job application forms are React-driven; fields are usually
// exposed with name/id attributes containing "name" and "email".
async function applyOnAshby(page, seeker) {
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

  if (await detectCaptcha(page)) {
    return { ok: false, reason: 'CAPTCHA detected — needs a human to solve. Handed off.', captcha: true };
  }

  const submitBtn = await page.$('button[type="submit"]');
  if (!submitBtn) {
    return { ok: false, reason: 'Could not find a submit button on this form.' };
  }

  const missingFields = await findMissingRequiredFields(page, [nameField, emailField, resumeInput]);

  await humanDelay();
  await submitBtn.click();
  await page.waitForLoadState('networkidle');

  return { ok: true, missingFields };
}

// Workable's hosted apply forms typically use name="candidate[name]" or
// separate first/last name fields, plus name="candidate[email]".
async function applyOnWorkable(page, seeker) {
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

  if (await detectCaptcha(page)) {
    return { ok: false, reason: 'CAPTCHA detected — needs a human to solve. Handed off.', captcha: true };
  }

  const submitBtn = await page.$('button[type="submit"]');
  if (!submitBtn) {
    return { ok: false, reason: 'Could not find a submit button on this form.' };
  }

  const missingFields = await findMissingRequiredFields(page, [fullNameField, firstName, lastName, emailField, resumeInput]);

  await humanDelay();
  await submitBtn.click();
  await page.waitForLoadState('networkidle');

  return { ok: true, missingFields };
}

// Fallback for watched-page postings, which don't come from a known ATS —
// there's no fixed field layout to target, so this uses the broadest
// reasonable selectors (similar spirit to applyOnAshby, just looser) to
// find a name/email/phone/resume field on whatever form the page has. It
// still only submits when it can find at minimum a name-like and email
// field — anything less and it hands off to a manual-review report rather
// than guess at an unrecognizable form.
async function applyGeneric(page, seeker) {
  await page.waitForLoadState('networkidle').catch(() => {});

  const nameField = await page.$('input[name*="name" i]:not([name*="user" i]):not([type="email"]), input[id*="name" i]:not([id*="user" i]), input[placeholder*="full name" i], input[placeholder*="your name" i]');
  const emailField = await page.$('input[type="email"], input[name*="email" i], input[id*="email" i], input[placeholder*="email" i]');
  const phoneField = await page.$('input[type="tel"], input[name*="phone" i], input[id*="phone" i], input[placeholder*="phone" i]');
  const resumeInput = await page.$('input[type="file"]');

  if (!nameField || !emailField) {
    return { ok: false, reason: 'This page\'s application form doesn\'t look like a standard job application — could not find recognizable name/email fields.' };
  }

  await nameField.fill(seeker.full_name);
  await humanDelay();
  await emailField.fill(seeker.dedicated_email || '');
  await humanDelay();

  if (phoneField && seeker.phone) {
    await phoneField.fill(seeker.phone);
    await humanDelay();
  }

  const resumeResult = await attachResume(resumeInput, seeker);
  if (resumeResult.error) return { ok: false, reason: resumeResult.error };

  if (await detectCaptcha(page)) {
    return { ok: false, reason: 'CAPTCHA detected — needs a human to solve. Handed off.', captcha: true };
  }

  const submitBtn = await page.$('button[type="submit"], input[type="submit"], button:has-text("Apply"), button:has-text("Submit")');
  if (!submitBtn) {
    return { ok: false, reason: 'Could not find a submit/apply button on this form.' };
  }

  const missingFields = await findMissingRequiredFields(page, [nameField, emailField, phoneField, resumeInput]);

  await humanDelay();
  await submitBtn.click();
  await page.waitForLoadState('networkidle').catch(() => {});

  return { ok: true, missingFields };
}

async function run() {
  console.log(`[apply] starting run at ${new Date().toISOString()}`);

  const { data: pending, error } = await supabase
    .from('job_matches')
    .select('*, job_seekers(*), job_sources(*)')
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

  const toProcess = pending.filter(m => {
    const blockedCompanies = m.job_seekers?.blocked_companies || [];
    const isBlockedCompany = blockedCompanies.some(b => b.toLowerCase() === (m.company_name || '').toLowerCase());
    if (isBlockedCompany) return false;
    if (alreadyTerminal.has(`${m.job_seeker_id}|${m.job_url}`)) return false;
    return m.status === 'approved' || (m.status === 'pending' && m.job_seekers?.application_mode === 'automatic');
  }).slice(0, MAX_PER_RUN);

  if (toProcess.length === 0) { console.log('[apply] no approved/automatic matches ready'); return; }

  const browser = await chromium.launch({ headless: true });

  for (const match of toProcess) {
    const seeker = match.job_seekers;
    const source = match.job_sources;
    console.log(`[apply] processing "${match.job_title}" @ ${match.company_name} for ${seeker.full_name}`);

    const context = await browser.newContext();
    const page = await context.newPage();

    try {
      await page.goto(match.job_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await humanDelay();

      let result;
      if (source?.source_type === 'greenhouse') {
        result = await applyOnGreenhouse(page, seeker);
      } else if (source?.source_type === 'lever') {
        result = await applyOnLever(page, seeker);
      } else if (source?.source_type === 'smartrecruiters') {
        result = await applyOnSmartRecruiters(page, seeker);
      } else if (source?.source_type === 'ashby') {
        result = await applyOnAshby(page, seeker);
      } else if (source?.source_type === 'workable') {
        result = await applyOnWorkable(page, seeker);
      } else if (match.is_custom_source) {
        result = await applyGeneric(page, seeker);
      } else {
        result = { ok: false, reason: `Auto-apply not yet implemented for source type "${source?.source_type}".` };
      }

      const formLabel = source?.source_type || (match.is_custom_source ? 'watched-page' : 'unknown');

      if (result.ok) {
        const note = missingFieldsNote(result.missingFields);
        console.log(`[apply]  ✔ submitted${note ? ' (some info still needed)' : ''}`);
        await logResult(match, 'success', `Submitted via ${formLabel} form automation.${note}`);
      } else if (result.captcha) {
        console.log(`[apply]  ⚠ captcha — needs manual action`);
        await logResult(match, 'captcha_blocked', result.reason);
      } else {
        console.log(`[apply]  ✖ ${result.reason}`);
        await logResult(match, 'needs_manual_action', result.reason);
      }
    } catch (err) {
      const isNetworkIssue = /net::|ERR_|timeout|ENOTFOUND|EAI_AGAIN/i.test(err.message || '');
      const note = isNetworkIssue
        ? `This posting's link appears broken, mistyped, or no longer exists (${err.message}).`
        : err.message;
      console.error(`[apply]  ✖ ${isNetworkIssue ? 'broken link' : 'error'}:`, err.message);
      await logResult(match, isNetworkIssue ? 'needs_manual_action' : 'failed', note);
    } finally {
      await context.close();
      await humanDelay();
    }
  }

  await browser.close();
  console.log('[apply] run complete');
}

module.exports = { run };

if (require.main === module) {
  run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
}
