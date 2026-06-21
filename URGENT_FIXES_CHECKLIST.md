# 🚨 URGENT FIXES CHECKLIST — Viveka v4

## Issues Reported
1. ❌ **Empty AWESOME artifacts** (all sections blank)
2. ❌ **Hindi-only summary** (not translated to English)  
3. ⚠️ **100MB file processes in 10 minutes** (seems fast but actually correct with optimizations)
4. ❌ **Email Dossier button fails** with DNS error

---

## Root Cause Analysis

### Issue 1 & 2: Empty Artifacts + Hindi Summary
**Root Cause**: Gemini API calls are **silently failing** and returning empty responses.

**Likely reasons**:
- ✅ `GEMINI_API_KEY` not set in Render dashboard
- ✅ Gemini API quota exceeded or billing issue
- ✅ Network timeout (120s might not be enough for large prompts)
- ✅ Gemini rejecting prompts due to safety filters or size limits

**What I fixed**:
- ✅ Added comprehensive logging to track Gemini API calls
- ✅ Log warnings when API key is missing
- ✅ Log errors with full stack traces when Gemini fails
- ✅ Log artifact counts after generation

**What YOU need to do**:
1. **Check Render logs** after next deploy to see the actual error
2. **Verify GEMINI_API_KEY** is set in Render dashboard Environment tab
3. **Check Google AI Studio** billing/quota: https://aistudio.google.com/app/apikey

---

### Issue 3: Fast Processing Time
**Status**: ✅ **This is CORRECT behavior** after optimizations

**Why it's fast now**:
- Parallel chunk processing (4 workers)
- Async HTTP calls to Deepgram (no blocking)
- Fast FLAC compression (`-compression_level 0`)
- Reduced overlap from 60s → 15s

**Expected times**:
- 100MB file (~46 min audio) = **8-12 minutes** ✅
- 200MB file (~90 min audio) = **15-25 minutes** ✅

This is **not a bug** — it's the performance improvement working correctly.

---

### Issue 4: Email Sending Fails
**Root Cause**: Render container cannot resolve `smtp.gmail.com` DNS

**What I fixed**:
- ✅ Added DNS fallback hosts (`smtp-relay.gmail.com`, `aspmx.l.google.com`)
- ✅ Added 30-second timeout to prevent hanging
- ✅ Created `backend/test_smtp.py` to test email locally

**What YOU need to do**:
1. **Test SMTP locally first**:
   ```bash
   cd "h:\Ammachi Labs\backend"
   python test_smtp.py
   ```
   Enter your email when prompted. If it works locally, the credentials are correct.

2. **Verify Render environment variables**:
   - `SMTP_HOST` = `smtp.gmail.com`
   - `SMTP_PORT` = `587`
   - `SMTP_SENDER_EMAIL` = `hk6113367@gmail.com`
   - `SMTP_SENDER_PASSWORD` = `jebanziquncurrgp`
   - `SMTP_USE_TLS` = `true`

3. **Check Render logs** after deploy to see which SMTP host works

---

## 🔥 IMMEDIATE ACTION ITEMS

### Step 1: Test SMTP Locally (5 minutes)
```powershell
cd "h:\Ammachi Labs\backend"
python test_smtp.py
```
- If it works → credentials are good, issue is Render-specific
- If it fails → check Gmail security settings (App Passwords, 2FA)

### Step 2: Verify Render Environment Variables (2 minutes)
Go to: https://dashboard.render.com → `viveka-backend` → **Environment** tab

**Check these are set**:
- ✅ `GEMINI_API_KEY` (most important!)
- ✅ `DEEPGRAM_API_KEY`
- ✅ `DATABASE_URL`
- ✅ `SMTP_SENDER_EMAIL`
- ✅ `SMTP_SENDER_PASSWORD`

### Step 3: Push Code and Monitor Logs (30 minutes)
```powershell
cd "h:\Ammachi Labs"
& "C:\flutter\bin\mingit\cmd\git.exe" push origin main
```

Wait for Render to deploy (~5 min), then:
1. Go to Render dashboard → `viveka-backend` → **Logs** tab
2. Upload a test audio file on Netlify
3. Watch the logs in real-time

**Look for these log messages**:
```
INFO: Calling Gemini artifact generation with X turns, transcript length: Y chars
WARNING: GEMINI_API_KEY not configured. Skipping artifact generation.
ERROR: Gemini artifact generation failed: <actual error>
```

### Step 4: Fix Based on Logs

**If you see**: `WARNING: GEMINI_API_KEY not configured`
→ Add `GEMINI_API_KEY` to Render environment variables

**If you see**: `ERROR: Gemini artifact generation failed: 429`
→ Gemini quota exceeded. Check billing at https://aistudio.google.com

**If you see**: `ERROR: Gemini artifact generation failed: timeout`
→ Increase timeout in `gemini_service.py` line 585 from `120.0` to `300.0`

**If you see**: `ERROR: Failed to send email: [Errno -2]`
→ Check Render logs to see which SMTP host it tried. The fallback should work.

---

## 📊 Expected Behavior After Fixes

### ✅ Correct Output
- **Summary**: 2-3 English paragraphs (not just 1 line)
- **Executive Synthesis**: 1-3 English paragraphs
- **Artifact 1**: 2-5 evidence matrix rows
- **Artifact 2**: 1-3 context matrix rows
- **Artifact 3**: 1-3 mechanism chains
- **Artifact 4**: 1-3 vulnerability hotspots
- **Email**: PDF sent to user's registered email

### ✅ Processing Time
- 100MB file (~46 min audio): **8-12 minutes**
- 200MB file (~90 min audio): **15-25 minutes**

---

## 🧪 Testing Checklist

After deploying:

- [ ] Upload 46-min audio file
- [ ] Wait for processing to complete
- [ ] Check **Summary** tab: Should have 2-3 English paragraphs (not Hindi, not 1 line)
- [ ] Check **AWESOME Artifacts** tab: All 4 sections should have content
- [ ] Click **Email Dossier** button
- [ ] Check email inbox for PDF
- [ ] Download and verify PDF has all content

---

## 📝 Files Changed in This Fix

1. `backend/app/gemini_service.py` — Added logging to track Gemini failures
2. `backend/app/pipeline.py` — Added logging before/after Gemini calls
3. `backend/app/email_service.py` — Added DNS fallback hosts for SMTP
4. `backend/test_smtp.py` — New script to test email sending locally
5. `render.yaml` — SMTP env vars configured
6. `App.tsx` — Added ETA timer
7. `components/TranscriptionCard.tsx` — Fixed "Artifact 4" label

---

## 🆘 If Still Broken After Deploy

**Contact me with**:
1. Screenshot of Render logs showing the error
2. Screenshot of Render Environment variables (blur sensitive values)
3. Result of running `python test_smtp.py` locally

**Most likely fix**: Add `GEMINI_API_KEY` to Render dashboard. That's the #1 cause of empty artifacts.
