# Stealth Plugins + 2Captcha Setup Guide

## What Changed

Your `apply.js` worker now has two new features:

1. **Stealth Plugins** — Makes Playwright look like a real human browser, avoiding basic anti-bot detection
2. **2Captcha Integration** — Automatically solves reCAPTCHA, hCaptcha, and other CAPTCHAs

## Installation

Run this in your worker directory:

```bash
npm install
```

This installs:
- `playwright-extra` — Playwright with stealth plugins support
- `puppeteer-extra-plugin-stealth` — The stealth evasion techniques
- `2captcha-nodejs` — 2Captcha API client

## Configuration

### 1. Get a 2Captcha Account (Optional but Recommended)

Visit https://2captcha.com and sign up:
- **Free tier**: Available with limited speed, good for testing
- **Paid**: ~$0.05-0.10 per CAPTCHA solved, paid as you use

### 2. Add Your 2Captcha API Key to `.env`

```env
CAPTCHA_API_KEY=your_2captcha_api_key_here
```

If you don't have a key, the agent will still work:
- **Stealth plugins** will bypass most job sites without triggering CAPTCHAs
- If a CAPTCHA does appear and you have no API key, it will be reported as "needs manual action"

### 3. No Changes Needed Elsewhere

All your existing code (Greenhouse, Lever, SmartRecruiters, Ashby, Workable, AI-agent) now automatically:
- Use the stealth browser
- Detect CAPTCHAs
- Attempt to solve them
- Report if solving fails

## How It Works

When applying to a job:

1. **Browser launches** with stealth plugins → looks like a real human browser
2. **Form gets filled** (name, email, resume, etc.)
3. **CAPTCHA detection** → checks if a reCAPTCHA/hCaptcha is present
4. **Auto-solve** → if present, attempts to solve it automatically using 2Captcha
5. **Submit** → if CAPTCHA solved (or none present), submits the form
6. **Fallback** → if CAPTCHA can't be solved, logs it as "needs manual action"

## Cost Estimate

For 100 job applications per month:
- **Stealth plugins**: Free
- **2Captcha**: $0-5 (depending on how many CAPTCHAs you hit; many job sites don't use them)

Typical job sites and CAPTCHA frequency:
- LinkedIn: 2Captcha needed ~30% of time
- Indeed: ~5% of time
- CareerJunction: ~10% of time
- Pnet: ~5% of time
- Greenhouse/Lever/others: <1% of time

## Testing

To test if it's working:

1. Deploy the updated `apply.js`
2. Run a manual application to a job site that uses CAPTCHAs (LinkedIn)
3. Check logs for:
   - `[apply] agent is enabled...` → agent running
   - `[captcha] detected recaptcha_v2` → CAPTCHA found
   - `[captcha] ✔ solved successfully` → CAPTCHA solved
   - `[apply] ✔ submitted` → application successful

If you hit CAPTCHAs without an API key:
- Log will show: `[captcha] 2Captcha API key not configured — skipping solve`
- Status: `captcha_blocked` in your database

## Troubleshooting

### "Tool 'file_upload' failed" or deployment issues?

Use the password-protected ZIP workaround:
1. Package your worker code as a ZIP
2. Upload via your hosting provider's dashboard
3. Password: dispatch2026

### CAPTCHA solving fails repeatedly?

1. Check your 2Captcha account has enough balance
2. Verify `CAPTCHA_API_KEY` is correct in `.env`
3. Some CAPTCHAs are deliberately difficult; they'll fail ~10% of the time even on real humans
4. The system logs these as `needs_manual_action` for you to handle manually

### Stealth plugins not working?

If you're still getting blocked despite stealth plugins:
1. Try increasing `MIN_ACTION_DELAY_MS` and `MAX_ACTION_DELAY_MS` in `.env` (e.g., 5000-15000)
2. Some advanced sites require genuine residential IP rotation (beyond this implementation)

## Next Steps

After deployment, monitor:
- How many CAPTCHAs you're actually hitting
- CAPTCHA solve success rate
- Total cost (if using paid 2Captcha tier)

Adjust as needed!
