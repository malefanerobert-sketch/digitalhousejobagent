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

  const captchaBlock = await handleCaptcha(page);
  if (captchaBlock) return captchaBlock;

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

  const captchaBlock = await handleCaptcha(page);
  if (captchaBlock) return captchaBlock;

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

  const captchaBlock = await handleCaptcha(page);
  if (captchaBlock) return captchaBlock;

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

  const captchaBlock = await handleCaptcha(page);
  if (captchaBlock) return captchaBlock;

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

  const captchaBlock = await handleCaptcha(page);
  if (captchaBlock) return captchaBlock;

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
    '[role="button"]:has-text("Submit")'
  );
  if (submitBtn) return { el: submitBtn, isFinal: true };
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

async function applyAI(page, seeker) {
  let lastMissingFields = [];
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

    await humanDelay();
    await stepBtn.el.click().catch(() => {});
    await page.waitForLoadState('networkidle').catch(() => {});

    if (stepBtn.isFinal) {
      return { ok: true, missingFields: lastMissingFields };
    }
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
    if (alreadyTerminal.has(`${m.job_seeker_id}|${m.job_url}`)) return false;
    return m.status === 'approved' || (m.status === 'pending' && m.job_seekers?.application_mode === 'automatic');
  }).slice(0, MAX_PER_RUN);

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
        } else {
          // Everything else — watched pages AND autonomous-search postings
          // (Adzuna/RemoteOK/Jobmail, which have no job_sources row and
          // aren't is_custom_source) — goes through the same AI-driven form
          // filler. It was previously gated to is_custom_source only, which
          // meant every autonomously-discovered job structurally could never
          // be applied to and always landed in needs_manual_action. applyAI()
          // was built to handle "any layout it's never seen before", which is
          // exactly what an arbitrary job-board posting is.
          result = await applyAI(page, seeker);
        }

        const formLabel = source?.source_type || (match.is_custom_source ? 'watched-page' : 'job-board');

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
