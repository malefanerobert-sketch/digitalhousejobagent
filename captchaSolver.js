/**
 * 2Captcha integration for solving CAPTCHAs on job-application forms.
 * Supports reCAPTCHA v2 (checkbox + invisible), reCAPTCHA v3, hCaptcha,
 * and Cloudflare Turnstile.
 *
 * Design notes:
 * - Loaded lazily. Missing package or missing API key -> solver silently
 *   disables; the rest of the worker (discovery, non-CAPTCHA'd applies)
 *   keeps running.
 * - Correct npm package is "2captcha" (Solver class). The old
 *   "2captcha-nodejs" is an empty Apify boilerplate — do NOT use it.
 * - Detection walks every frame on the page, not just the top-level
 *   document, because most job sites nest the widget inside iframes.
 * - After injecting the token we ALSO invoke the site's data-callback
 *   function (when present). Many forms keep the submit button disabled
 *   until that callback fires, so setting the hidden input alone is
 *   not enough.
 */

let Solver = null;
try { Solver = require('2captcha').Solver; } catch (_) { Solver = null; }

const API_KEY = process.env.CAPTCHA_API_KEY;
const ENABLED = Boolean(API_KEY && Solver);

const solver = ENABLED ? new Solver(API_KEY) : null;
if (API_KEY && !Solver) {
  console.warn('[captcha] CAPTCHA_API_KEY is set but the "2captcha" npm package is not installed — CAPTCHAs will report as blocked.');
}

// One-shot balance check at boot so a $0 account is loud instead of silent.
// Runs asynchronously — never blocks module loading.
if (ENABLED) {
  solver.balance()
    .then(bal => {
      const n = Number(bal);
      if (!Number.isFinite(n)) {
        console.log('[captcha] enabled, balance:', bal);
      } else if (n <= 0) {
        console.warn(`[captcha] ⚠ enabled but balance is $${n.toFixed(3)} — solves WILL fail until you top up at 2captcha.com/pay`);
      } else if (n < 0.5) {
        console.warn(`[captcha] enabled, balance $${n.toFixed(3)} — running low, consider topping up`);
      } else {
        console.log(`[captcha] enabled, balance $${n.toFixed(3)}`);
      }
    })
    .catch(err => console.warn('[captcha] enabled but balance check failed:', err.message));
} else if (!API_KEY) {
  console.log('[captcha] CAPTCHA_API_KEY not set — solver disabled (CAPTCHA-guarded jobs will log as captcha_blocked)');
}

/* -------------------------------------------------------------------------- */
/* Detection                                                                  */
/* -------------------------------------------------------------------------- */

// Try every frame (top + nested) to find sitekey/config metadata for
// whichever widget is embedded. Returns the first hit or null.
async function detectCaptcha(page) {
  const frames = [page.mainFrame(), ...page.frames().filter(f => f !== page.mainFrame())];

  for (const frame of frames) {
    try {
      const found = await frame.evaluate(() => {
        // ---- reCAPTCHA v2 (checkbox / invisible) ----
        // v2 widgets have a [data-sitekey] container OR a g-recaptcha class.
        const v2El = document.querySelector('.g-recaptcha[data-sitekey], [data-sitekey][data-callback], div[data-sitekey]:not([data-hcaptcha-widget-id])');
        if (v2El) {
          const sitekey = v2El.getAttribute('data-sitekey');
          if (sitekey && !document.querySelector('.h-captcha')) {
            return {
              type: 'recaptcha_v2',
              sitekey,
              invisible: v2El.getAttribute('data-size') === 'invisible',
              callbackName: v2El.getAttribute('data-callback') || null,
            };
          }
        }
        // reCAPTCHA v2 loader script hint (fallback if the container isn't
        // in the DOM yet but the API script is loaded).
        const rcScript = document.querySelector('script[src*="recaptcha/api.js"], script[src*="recaptcha/enterprise.js"]');
        if (rcScript && !window.hcaptcha) {
          const kMatch = rcScript.src.match(/[?&]render=([^&]+)/);
          if (kMatch && kMatch[1] && kMatch[1] !== 'explicit') {
            // ?render=SITEKEY on the loader script = reCAPTCHA v3 in almost every real deployment.
            return {
              type: 'recaptcha_v3',
              sitekey: kMatch[1],
              action: 'submit',
              minScore: 0.4,
              callbackName: null,
            };
          }
        }

        // ---- hCaptcha ----
        const hcEl = document.querySelector('.h-captcha[data-sitekey], [data-hcaptcha-widget-id][data-sitekey]');
        if (hcEl) {
          const sitekey = hcEl.getAttribute('data-sitekey');
          if (sitekey) {
            return {
              type: 'hcaptcha',
              sitekey,
              callbackName: hcEl.getAttribute('data-callback') || null,
            };
          }
        }

        // ---- Cloudflare Turnstile ----
        const tsEl = document.querySelector('.cf-turnstile[data-sitekey], [data-sitekey][data-cf-turnstile-widget-id]');
        if (tsEl) {
          const sitekey = tsEl.getAttribute('data-sitekey');
          if (sitekey) {
            return {
              type: 'turnstile',
              sitekey,
              action: tsEl.getAttribute('data-action') || null,
              callbackName: tsEl.getAttribute('data-callback') || null,
            };
          }
        }

        return null;
      });

      if (found) {
        return { ...found, pageUrl: page.url(), frameUrl: frame.url() };
      }
    } catch (_) {
      // frame may have detached mid-eval — ignore and continue
    }
  }

  return null;
}

/* -------------------------------------------------------------------------- */
/* Solve                                                                      */
/* -------------------------------------------------------------------------- */

async function solveCaptcha(info) {
  if (!ENABLED) {
    console.log('[captcha] 2Captcha API key not configured — skipping solve');
    return null;
  }

  try {
    console.log(`[captcha] solving ${info.type} (sitekey ${String(info.sitekey).slice(0, 10)}…)`);
    let result;

    if (info.type === 'recaptcha_v2') {
      result = await solver.recaptcha(info.sitekey, info.pageUrl, info.invisible ? { invisible: 1 } : undefined);
    } else if (info.type === 'recaptcha_v3') {
      result = await solver.recaptcha(info.sitekey, info.pageUrl, {
        version: 'v3',
        action: info.action || 'submit',
        min_score: info.minScore || 0.4,
      });
    } else if (info.type === 'hcaptcha') {
      result = await solver.hcaptcha(info.sitekey, info.pageUrl);
    } else if (info.type === 'turnstile') {
      // 2captcha's turnstile method takes (sitekey, pageurl, extra?).
      // Older client versions expose it as solver.cloudflareTurnstile — try both.
      const fn = solver.turnstile ? 'turnstile' : (solver.cloudflareTurnstile ? 'cloudflareTurnstile' : null);
      if (!fn) throw new Error('installed 2captcha client is too old to solve Turnstile — upgrade the "2captcha" npm package');
      result = await solver[fn](info.sitekey, info.pageUrl, info.action ? { action: info.action } : undefined);
    } else {
      throw new Error(`unsupported captcha type: ${info.type}`);
    }

    const token = result?.data || null;
    if (token) {
      console.log('[captcha] ✔ solved');
      return token;
    }
  } catch (err) {
    console.error('[captcha] solve error:', err.message);
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Inject                                                                     */
/* -------------------------------------------------------------------------- */

// Inject the solved token into whichever frame the widget lives in,
// populate the standard hidden input, AND invoke the site's callback so
// gated submit buttons unlock.
async function injectToken(page, info, token) {
  const targetFrame = page.frames().find(f => f.url() === info.frameUrl) || page.mainFrame();

  try {
    const injected = await targetFrame.evaluate(({ token, type, callbackName }) => {
      const results = {};

      // Standard hidden inputs each widget type expects.
      const inputSelectors = {
        recaptcha_v2: ['textarea[name="g-recaptcha-response"]', 'input[name="g-recaptcha-response"]'],
        recaptcha_v3: ['textarea[name="g-recaptcha-response"]', 'input[name="g-recaptcha-response"]'],
        hcaptcha:     ['textarea[name="h-captcha-response"]', 'input[name="h-captcha-response"]', 'textarea[name="g-recaptcha-response"]'],
        turnstile:    ['input[name="cf-turnstile-response"]'],
      };

      // Create the input if it doesn't exist yet (v3 is often invisible until executed).
      let wrote = false;
      for (const sel of (inputSelectors[type] || [])) {
        const els = document.querySelectorAll(sel);
        els.forEach(el => {
          el.style.display = '';
          el.value = token;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          wrote = true;
        });
      }
      if (!wrote && (type === 'recaptcha_v2' || type === 'recaptcha_v3')) {
        const ta = document.createElement('textarea');
        ta.name = 'g-recaptcha-response';
        ta.style.display = 'none';
        ta.value = token;
        document.body.appendChild(ta);
        wrote = true;
      }
      results.hiddenInputWritten = wrote;

      // Fire the site's own callback. This is what actually unlocks
      // submit buttons on most modern forms.
      const invokeCallback = (name) => {
        if (!name) return false;
        try {
          const fn = name.split('.').reduce((o, k) => (o == null ? o : o[k]), window);
          if (typeof fn === 'function') { fn(token); return true; }
        } catch (_) { /* ignore */ }
        return false;
      };
      results.explicitCallbackFired = invokeCallback(callbackName);

      // Common auto-callback names widgets emit even without data-callback.
      ['onCaptchaSuccess', 'captchaCallback', 'onRecaptchaSuccess', 'onHcaptchaSuccess', 'onTurnstileSuccess']
        .forEach(n => invokeCallback(n));

      // Poke grecaptcha internals so its own onSuccess handlers wake up.
      try {
        if (window.___grecaptcha_cfg && window.___grecaptcha_cfg.clients) {
          Object.values(window.___grecaptcha_cfg.clients).forEach(client => {
            const walk = (obj) => {
              if (!obj || typeof obj !== 'object') return;
              Object.values(obj).forEach(v => {
                if (v && typeof v === 'object') {
                  if (typeof v.callback === 'function') { try { v.callback(token); } catch (_) {} }
                  walk(v);
                }
              });
            };
            walk(client);
          });
        }
      } catch (_) { /* ignore */ }

      return results;
    }, { token, type: info.type, callbackName: info.callbackName });

    console.log(`[captcha] token injected (hiddenInput=${injected.hiddenInputWritten}, callback=${injected.explicitCallbackFired})`);
    return true;
  } catch (err) {
    console.error('[captcha] injection error:', err.message);
    return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

async function solveCaptchaOnPage(page) {
  const info = await detectCaptcha(page);
  if (!info) {
    console.log('[captcha] no CAPTCHA detected');
    return false;
  }
  console.log(`[captcha] detected ${info.type} in ${info.frameUrl === info.pageUrl ? 'main frame' : 'iframe'}`);

  const token = await solveCaptcha(info);
  if (!token) {
    console.log('[captcha] ⚠ solve failed — job will be logged as captcha_blocked');
    return false;
  }

  return await injectToken(page, info, token);
}

module.exports = {
  ENABLED,
  detectCaptcha,
  // Back-compat alias for existing callers.
  detectRecaptcha: detectCaptcha,
  solveCaptcha,
  solveRecaptcha: solveCaptcha,
  injectToken,
  solveCaptchaOnPage,
};
