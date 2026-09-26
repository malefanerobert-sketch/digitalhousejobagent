# Stealth Plugins + 2Captcha Setup Guide

## What This Gives You

Your `apply.js` worker has two features that raise the success rate of automated job applications:

1. **Stealth Plugins** — makes Playwright look like a real human browser, avoiding basic anti-bot detection.
2. **2Captcha Integration** — automatically solves reCAPTCHA v2/v3, hCaptcha, and Cloudflare Turnstile.

## Installation

Run this in the worker directory (or let Railway/Nixpacks do it on deploy):

```bash
npm install
```

This installs (all pinned in `package.json`):

- `playwright-extra` — Playwright with plugin support
- `puppeteer-extra-plugin-stealth` — anti-fingerprinting evasion techniques
- `2captcha` — the real 2Captcha API client (**not** `2captcha-nodejs`, which is a fake/empty package on npm — do not install it)

## Configuration

### 1. Create a 2Captcha *customer* account

Sign up at [2captcha.com](https://2captcha.com). At the signup step choose the **Customer / Software developer** option (not "Worker / earn money" — that is the opposite side of the marketplace and has no API access).

Fund the account at [2captcha.com/pay](https://2captcha.com/pay):

- Minimum deposit: $3.
- Cost per solve: ~$0.001 for reCAPTCHA v2, ~$0.002 for v3 / hCaptcha / Turnstile, higher for image challenges.
- From South Africa the reliable payment methods are card (may need to enable international purchases at your bank) or **USDT-TRC20** bought on Luno/VALR.

### 2. Add the API key to environment variables

Copy your key from [2captcha.com/enterpage](https://2captcha.com/enterpage) (top of the page). Set it as:

```env
CAPTCHA_API_KEY=your_2captcha_api_key_here
```

- **Local dev:** put it in `.env`.
- **Railway:** open the service → Variables → add `CAPTCHA_API_KEY`. Railway auto-redeploys.

### 3. That's it

Every existing code path (Greenhouse, Lever, SmartRecruiters, Ashby, Workable, AI agent) already routes through `captchaSolver.js` — no per-integration changes needed.

## Runtime Behavior

At worker boot you should see one of these lines in the log:

- `[captcha] enabled, balance $3.000` — key is valid, funds available.
- `[captcha] ⚠ enabled but balance is $0.000 — solves WILL fail until you top up …` — key valid, out of funds.
- `[captcha] CAPTCHA_API_KEY not set — solver disabled …` — key missing, applications will still run but CAPTCHA-guarded ones will log as `captcha_blocked`.

Per application, when a CAPTCHA is hit you should see:

```
[captcha] detected recaptcha_v2 in iframe
[captcha] solving recaptcha_v2 (sitekey 6Le-wvkS…)
[captcha] ✔ solved
[captcha] token injected (hiddenInput=true, callback=true)
[apply] ✔ submitted
```

If injection reports `callback=false`, the site does not use a `data-callback` handler — usually harmless, submission still works.

## Approximate CAPTCHA Frequency by Site

| Site | reCAPTCHA/hCaptcha hit rate |
| --- | --- |
| LinkedIn Easy Apply | ~30% |
| Indeed | ~5% |
| CareerJunction | ~10% |
| Pnet | ~5% |
| Greenhouse / Lever / most ATS | <1% |
| Cloudflare-fronted boards | ~15% (mostly Turnstile) |

For 100 applications a month, expect **$0-5** in 2Captcha spend.

## Troubleshooting

### CAPTCHAs report as blocked even with a key set

1. Check the boot log for `[captcha] enabled, balance …`. If it says `disabled`, the env var did not reach the process — verify in Railway Variables and redeploy.
2. Check your 2Captcha dashboard has balance.
3. Watch for `[captcha] no CAPTCHA detected` right before submission on a site you *know* has one — that usually means the widget renders after our detection runs. Increase `MIN_ACTION_DELAY_MS` in `.env` (e.g. `6000`).

### Solve succeeds but submit button stays disabled

The site is using a `data-callback` we did not catch. Grab the page HTML, find the widget's `data-callback="fnName"`, and confirm `[captcha] token injected (…, callback=true)` is in the log. If `callback=false`, tell me the site and I will add the specific hook.

### Getting blocked despite stealth plugins

1. Raise `MIN_ACTION_DELAY_MS` / `MAX_ACTION_DELAY_MS` (`5000` / `15000` is a safer default for aggressive sites).
2. Some enterprise sites (Kasada, PerimeterX, DataDome) require residential proxy rotation — beyond the scope of this setup.
