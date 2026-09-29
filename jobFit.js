'use strict';
/**
 * jobFit.js — shared "does this job actually fit this seeker?" helpers.
 *
 * 1. Location aliases: "Johannesburg" and "Gauteng" (and the Johannesburg
 *    metro suburbs) are treated as the same place, so a job listed as
 *    "Gauteng, ZA" or "Sandton" is in scope for a seeker who picked
 *    Johannesburg (and the other way round).
 * 2. Keyword scoring: a job title must contain ALL the words of one of the
 *    seeker's target roles ("data capture" needs both "data" AND "capture"),
 *    instead of matching on the single word "data".
 * 3. Seniority guard: seekers whose highest qualification is below degree
 *    level (Matric / certificate / diploma) are not matched to or applied for
 *    engineer / architect / scientist / senior / lead / manager style roles,
 *    unless that word is part of one of their own target roles.
 */

const norm = (s) => String(s || '').toLowerCase()
  .replace(/&#x2013;|&ndash;/g, ' ')
  .replace(/[^a-z0-9\s]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

// ---------- Locations ----------
const JHB_METRO = [
  'johannesburg', 'joburg', 'jhb', 'jozi', 'sandton', 'midrand', 'randburg',
  'roodepoort', 'soweto', 'rosebank', 'fourways', 'bryanston', 'sandringham',
  'braamfontein', 'bedfordview', 'edenvale', 'germiston', 'kempton park',
  'boksburg', 'benoni', 'alberton', 'brakpan', 'springs', 'krugersdorp',
  'ekurhuleni', 'lonehill', 'northriding', 'melrose', 'illovo', 'parktown',
  'houghton', 'linden'
];
const TSHWANE_METRO = ['pretoria', 'tshwane', 'centurion', 'clubview', 'silverton', 'menlyn', 'hatfield', 'brooklyn'];
const GAUTENG_OTHER = ['vereeniging', 'vanderbijlpark', 'westonaria', 'randfontein', 'heidelberg'];

const GAUTENG_ALL = ['gauteng', ...JHB_METRO, ...TSHWANE_METRO, ...GAUTENG_OTHER];
// "Johannesburg" ≡ Gauteng: the seeker's pick expands to the Johannesburg
// metro plus the province name. (Pretoria-area jobs are only included when
// the seeker picks Gauteng, Pretoria, Tshwane or Centurion.)
const JHB_ALIASES = ['gauteng', ...JHB_METRO];
const PTA_ALIASES = ['gauteng', ...TSHWANE_METRO];

function aliasesFor(pref) {
  const p = norm(pref);
  if (!p) return [];
  if (p === 'gauteng') return GAUTENG_ALL;
  if (JHB_ALIASES.includes(p) && p !== 'gauteng') {
    // Johannesburg / Joburg / JHB / Jozi expand to the whole metro; a specific
    // suburb (Sandton, Midrand…) only expands to itself + the generic
    // "Johannesburg" / "Gauteng" labels a job board might use for it.
    if (['johannesburg', 'joburg', 'jhb', 'jozi'].includes(p)) return JHB_ALIASES;
    return [p, 'johannesburg', 'joburg', 'gauteng'];
  }
  if (TSHWANE_METRO.includes(p)) return PTA_ALIASES;
  return [p];
}

function containsPhrase(haystackNorm, phrase) {
  return (' ' + haystackNorm + ' ').includes(' ' + phrase + ' ');
}

/** True if the job's location is inside the seeker's preferred locations. */
function locationInScope(jobLocation, preferredLocations) {
  const prefs = Array.isArray(preferredLocations) ? preferredLocations : [];
  if (prefs.length === 0 || (prefs.length === 1 && prefs[0] === 'All locations')) return true;
  const loc = norm(jobLocation);
  if (!loc) return false;
  return prefs.some(p => aliasesFor(p).some(a => containsPhrase(loc, a)) || loc.includes(norm(p)));
}

// ---------- Keyword matching ----------
const stemOf = (w) => w.length >= 5 ? w.slice(0, Math.max(4, w.length - 2)) : w;

function wordPresent(titleNorm, word) {
  const st = stemOf(word);
  return (' ' + titleNorm).includes(' ' + st);
}

/**
 * 0..1 score of how well a job title matches the seeker's target roles.
 * Exact role phrase => 0.9. Every word of a role present (in any order, with
 * light stemming: capture/capturer/capturing) => 0.75. A single shared word
 * ("data") is NOT a match => 0.
 */
function scoreTitle(title, keywords) {
  const t = norm(title);
  if (!t || !Array.isArray(keywords)) return 0;
  let best = 0;
  for (const kw of keywords) {
    const k = norm(kw);
    if (!k) continue;
    if (containsPhrase(t, k)) return 0.9;
    const words = k.split(' ').filter(Boolean);
    if (words.length && words.every(w => wordPresent(t, w))) best = Math.max(best, 0.75);
  }
  return best;
}

// ---------- Seniority / qualification ----------
const HIGHER_ROLE_WORDS = [
  'senior', 'sr', 'lead', 'principal', 'head', 'director', 'manager', 'chief',
  'architect', 'engineer', 'engineering', 'scientist', 'developer', 'devops',
  'consultant', 'specialist', 'analyst', 'analytics', 'analytic', 'actuary',
  'actuarial', 'statistician', 'researcher', 'data science', 'machine learning',
  'dba', 'executive', 'vp', 'graduate', 'phd', 'honours', 'bi developer'
];

function isSubDegree(qualification) {
  const q = norm(qualification);
  if (!q) return false; // unknown => don't restrict
  if (/(honours|bachelor|degree|masters|master s|phd|doctor|postgraduate|btech|bsc|ba )/.test(q)) return false;
  return /(matric|grade 12|grade 11|grade 10|senior certificate|nsc|certificate|diploma|n[1-6]\b|nqf|no formal|high school)/.test(q);
}

/** Does the title look like a role above the seeker's qualification level? */
function tooSenior(title, seeker) {
  if (!isSubDegree(seeker && seeker.highest_qualification)) return false;
  const t = norm(title);
  const own = (seeker.job_title_keywords || []).map(norm).join(' ');
  return HIGHER_ROLE_WORDS.some(w => containsPhrase(t, w) && !containsPhrase(own, w));
}

/** Title-level fit: seniority guard (and optionally the keyword gate). */
function titleFitsSeeker(title, seeker, { requireKeyword = false } = {}) {
  if (tooSenior(title, seeker)) return false;
  if (requireKeyword && scoreTitle(title, seeker.job_title_keywords) === 0) return false;
  return true;
}

module.exports = { locationInScope, scoreTitle, tooSenior, titleFitsSeeker, isSubDegree, norm };
