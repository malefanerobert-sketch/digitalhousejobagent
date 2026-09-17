/**
 * 2Captcha integration for solving CAPTCHAs
 * Handles reCAPTCHA v2, v3, hCaptcha, and image-based CAPTCHAs
 */

// 2Captcha solver is loaded lazily so a missing / uninstalled solver package
// never crashes the whole worker at boot — CAPTCHA support is optional, and
// the rest of the pipeline (discovery, applying to non-CAPTCHA'd forms) must
// keep running even when no solver library is available.
//
// NOTE: this used to try requiring "2captcha-nodejs" first — that package is
// literally just an empty Apify-actor boilerplate on npm (no captcha-solving
// code in it at all), not a real 2Captcha client, so it could never have
// worked. The real client is the "2captcha" package; its Solver class uses
// solver.recaptcha(...)/solver.hcaptcha(...), not the *Proxyless(...) method
// names this file used to call — those have been corrected below to match.
let Solver = null;
try { Solver = require('2captcha').Solver; } catch (_) { Solver = null; }

const API_KEY = process.env.CAPTCHA_API_KEY;
const ENABLED = Boolean(API_KEY && Solver);

const solver = ENABLED ? new Solver(API_KEY) : null;
if (API_KEY && !Solver) {
  console.warn('[captcha] CAPTCHA_API_KEY is set but no 2Captcha library is installed — CAPTCHAs will report as blocked.');
}

/**
 * Detect reCAPTCHA v2/v3 or hCaptcha on the page
 * Returns { type, sitekey, action } if found
 */
async function detectRecaptcha(page) {
  try {
    // reCAPTCHA v2 (checkbox or invisible)
    const recaptchaIframe = await page.$('iframe[src*="recaptcha"]');
    if (recaptchaIframe) {
      const sitekey = await page.evaluate(() => {
        const script = document.querySelector('script[src*="recaptcha"]');
        if (script) {
          const match = script.src.match(/k=([^&]+)/);
          if (match) return match[1];
        }
        const div = document.querySelector('[data-sitekey]');
        if (div) return div.getAttribute('data-sitekey');
        return null;
      });

      if (sitekey) {
        return {
          type: 'recaptcha_v2',
          sitekey,
          pageUrl: page.url()
        };
      }
    }

    // reCAPTCHA v3
    const recaptchaV3 = await page.evaluate(() => {
      if (window.grecaptcha && window.grecaptcha.getResponse) {
        return { detected: true };
      }
      return null;
    });
    if (recaptchaV3) {
      return { type: 'recaptcha_v3', sitekey: 'unknown', pageUrl: page.url() };
    }

    // hCaptcha
    const hcaptchaIframe = await page.$('iframe[src*="hcaptcha"]');
    if (hcaptchaIframe) {
      const sitekey = await page.evaluate(() => {
        const div = document.querySelector('[data-sitekey]');
        if (div) return div.getAttribute('data-sitekey');
        return null;
      });

      if (sitekey) {
        return {
          type: 'hcaptcha',
          sitekey,
          pageUrl: page.url()
        };
      }
    }
  } catch (err) {
    console.error('[captcha] detection error:', err.message);
  }

  return null;
}

/**
 * Solve reCAPTCHA v2/v3 or hCaptcha using 2Captcha
 */
async function solveRecaptcha(captchaInfo) {
  if (!ENABLED) {
    console.log('[captcha] 2Captcha API key not configured — skipping solve');
    return null;
  }

  try {
    console.log(`[captcha] attempting to solve ${captchaInfo.type}...`);

    let result;
    if (captchaInfo.type === 'recaptcha_v2') {
      result = await solver.recaptcha(captchaInfo.sitekey, captchaInfo.pageUrl);
    } else if (captchaInfo.type === 'recaptcha_v3') {
      result = await solver.recaptcha(captchaInfo.sitekey, captchaInfo.pageUrl, {
        version: 'v3',
        action: 'submit',
        min_score: 0.4
      });
    } else if (captchaInfo.type === 'hcaptcha') {
      result = await solver.hcaptcha(captchaInfo.sitekey, captchaInfo.pageUrl);
    }

    // The real 2captcha client resolves { data, id } — .data is the token.
    const token = result?.data || null;
    if (token) {
      console.log('[captcha] ✔ solved successfully');
      return token;
    }
  } catch (err) {
    console.error('[captcha] solve error:', err.message);
  }

  return null;
}

/**
 * Inject solved CAPTCHA token into the page
 */
async function injectToken(page, token, captchaType) {
  try {
    if (captchaType === 'recaptcha_v2' || captchaType === 'recaptcha_v3') {
      await page.evaluate((tok) => {
        if (window.grecaptcha) {
          window.grecaptcha.callback = () => console.log('[captcha] token injected');
          // This depends on how the form expects the token — common pattern:
          const tokenInput = document.querySelector('[name="g-recaptcha-response"]');
          if (tokenInput) {
            tokenInput.value = tok;
            tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      }, token);
    } else if (captchaType === 'hcaptcha') {
      await page.evaluate((tok) => {
        const tokenInput = document.querySelector('[name="h-captcha-response"]');
        if (tokenInput) {
          tokenInput.value = tok;
          tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, token);
    }
    return true;
  } catch (err) {
    console.error('[captcha] injection error:', err.message);
    return false;
  }
}

/**
 * Full CAPTCHA solve flow: detect → solve → inject
 */
async function solveCaptchaOnPage(page) {
  const captchaInfo = await detectRecaptcha(page);
  if (!captchaInfo) {
    console.log('[captcha] no CAPTCHA detected');
    return false;
  }

  console.log(`[captcha] detected ${captchaInfo.type}`);

  const token = await solveRecaptcha(captchaInfo);
  if (!token) {
    console.log('[captcha] ⚠ solve failed — will report CAPTCHA blocked');
    return false;
  }

  const injected = await injectToken(page, token, captchaInfo.type);
  return injected;
}

module.exports = {
  ENABLED,
  detectRecaptcha,
  solveRecaptcha,
  injectToken,
  solveCaptchaOnPage
};
