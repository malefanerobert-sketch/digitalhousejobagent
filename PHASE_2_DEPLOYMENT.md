# JobAgent: Phase 2 — Autonomous Discovery Worker Deployment

**Status**: ✅ READY TO DEPLOY  
**Date**: September 13, 2026

---

## 📋 What's Being Deployed

**discoverAuto.js** — Autonomous job discovery worker that:
- Queries Adzuna & RemoteOK for each user's enabled sources
- Filters to South Africa only (ZA)
- Scores matches with Claude API (50+ score only)
- Respects 8am-4pm SA time window (runs only in window)
- Saves matches to `job_matches` table
- Per-user discovery (each user gets their own search)

---

## 🚀 Deployment Steps

### Step 1: Create Railway Service

1. Go to **Railway Dashboard** → **New Project**
2. Click **Deploy from GitHub**
3. Connect your GitHub repo (where admin.html is)
4. Select the repo
5. Choose **Nixpacks** as builder
6. Click **Deploy**

### Step 2: Set Environment Variables in Railway

Once service is created, go to **Variables** tab and add:

```
SUPABASE_URL=https://celylskveytdwvuvsuvx.supabase.co
SUPABASE_SERVICE_KEY=[your-supabase-service-key]
CLAUDE_API_KEY=[your-anthropic-api-key]
ADZUNA_API_KEY=[your-adzuna-app-key]
```

**Where to find:**
- **SUPABASE_SERVICE_KEY**: Supabase Dashboard → Settings → API Keys → Service Role Key
- **CLAUDE_API_KEY**: Anthropic Console → API Keys
- **ADZUNA_API_KEY**: Adzuna Developer API credentials

### Step 3: Verify railway.json and package.json

The repo should have:
```
railway.json      ← Start command and builder config
package.json      ← Node dependencies
discoverAuto.js   ← Worker script
```

### Step 4: Test Locally (Optional but Recommended)

```bash
npm install
# Add env vars to .env file
SUPABASE_URL=... node discoverAuto.js
```

---

## ⏰ Schedule the Worker

The worker checks time window internally (8am-4pm SA only). To run it daily:

### Option A: Railway Cron Job (Recommended)

1. In Railway service → **Triggers** tab
2. Click **New Trigger** → **Cron**
3. Set schedule: `0 8 * * *` (8:00 AM UTC is ~10am SA in winter, ~11am in summer)
4. Or use: `0 6 * * *` (6:00 AM UTC - covers 8am SA across all seasons)
5. Click **Deploy**

The worker will run once per day. It internally checks if it's within 8am-4pm SA time and exits if not.

### Option B: External Cron (Using cron-job.org)

1. Create free account at cron-job.org
2. Create job that calls: `https://[your-railway-service-url]/trigger`
3. Set to run daily at 6am UTC

---

## 📊 What Happens When Worker Runs

1. **Check time window** → If not 8am-4pm SA, exit
2. **Load active users** with `auto_search_enabled=true` and `discovery_mode='auto'`
3. **For each user**:
   - Get enabled sources (Adzuna, RemoteOK)
   - Fetch jobs from each source (ZA only)
   - Filter by remote-only if set
   - Score with Claude API (0-100)
   - Keep only scores >= 50
   - Save to `job_matches` table

4. **Output**: Log results to Railway console

---

## 🔍 Monitoring & Logs

In Railway Dashboard:
1. Select your service
2. Click **Logs** tab
3. Watch real-time output from worker runs
4. Look for:
   - `✓ Adzuna: fetched X jobs`
   - `✓ RemoteOK: fetched X jobs`
   - `✓ Saved N matches for user`
   - `✅ Discovery complete. Total matches: X`

---

## 🛠️ Troubleshooting

### Worker runs but finds no jobs

**Possible causes:**
- Job titles are empty (set `job_title_keywords` in user profile)
- No users with `auto_search_enabled=true`
- No sources enabled for user

**Fix:** Check admin panel:
1. Go to Accounts tab
2. Click Settings for a test user
3. Set Discovery Mode to "Auto"
4. Enable at least one source (Adzuna or RemoteOK)
5. Make sure they have job keywords

### Claude API returns errors

**Possible causes:**
- Invalid API key
- Rate limiting
- Model name wrong

**Fix:**
1. Verify `CLAUDE_API_KEY` in Railway variables
2. Check Anthropic account has API credits
3. Check Anthropic quota limits

### Adzuna/RemoteOK returns 0 jobs

**Possible causes:**
- API key invalid (Adzuna requires it)
- Search query too specific
- No ZA jobs match query

**Fix:**
1. Verify `ADZUNA_API_KEY` is correct
2. Test Adzuna API manually: `https://api.adzuna.com/v1/api/jobs/za/search?app_id=jobagent&app_key=[KEY]&what=software&where=ZA`
3. Check job keywords in user profile

### Jobs saved but match_score = 0

**Cause:** Claude scoring failed but jobs still saved with 0 score

**Fix:**
1. Check Railway logs for Claude errors
2. Verify API key
3. Look for rate-limit errors

---

## 📈 Database Tables Used

| Table | Operation | Purpose |
|-------|-----------|---------|
| `job_seekers` | SELECT | Get users with `auto_search_enabled=true` |
| `user_job_sources_view` | SELECT | Get user's enabled sources |
| `job_matches` | UPSERT | Save discovered & scored jobs |
| `job_sources` | SELECT (implicit) | Via view to know source names |

---

## 🔐 Security & Permissions

- **Railway access**: Needs Supabase service key (has write access)
- **Supabase RLS**: job_matches table should allow inserts by worker (via service key)
- **Claude API**: Read-only (no writes to Anthropic)
- **Adzuna/RemoteOK**: Read-only (no auth required for RemoteOK, API key for Adzuna)

---

## ✅ Verification Checklist

After deployment:

- [ ] Railway service created and running
- [ ] Environment variables set correctly
- [ ] Cron trigger configured (8am SA time)
- [ ] At least one test user has:
  - [ ] `auto_search_enabled = true`
  - [ ] `discovery_mode = 'auto'`
  - [ ] One source enabled (Adzuna or RemoteOK)
  - [ ] Job title keywords set
- [ ] First cron run executes without errors
- [ ] Logs show jobs fetched and scored
- [ ] job_matches table has new entries
- [ ] Users see matched jobs in their app

---

## 📝 Next Steps

1. **Deploy to Railway** (this guide)
2. **Verify first run** (check logs, check job_matches table)
3. **Monitor daily runs** (watch logs)
4. **Adjust scoring** if matches feel wrong (edit Claude prompt in discoverAuto.js)
5. **Scale users** as confidence grows

---

## 💬 Common Questions

**Q: Can I run it more than once per day?**  
A: Yes, but be mindful of Claude API costs. Each discovery run costs ~1-2 cents per user. Run frequency = cost × users.

**Q: What if a user disables a source mid-search?**  
A: The cron job runs once per day at a fixed time. Mid-search changes are picked up the next day.

**Q: Can users see their matched jobs?**  
A: Yes, in the user app, under "Discovered Jobs" or similar (depends on your UI).

**Q: What if Claude can't score a job?**  
A: It gets a score of 0 and is saved anyway. You can filter out 0-score jobs in the UI.

---

**Ready to deploy? Start with Step 1.** 🚀
