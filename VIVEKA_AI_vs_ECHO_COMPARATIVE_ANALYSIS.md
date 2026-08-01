# Viveka AI & Echo — Technical Comparison

**Ammachi Labs**  
June 2026

---

## Overview

Two audio transcription systems are being evaluated for integration:

**Viveka AI** — Research-focused transcription platform with AWESOME framework analysis  
**Echo (SpeechToScript)** — Pipeline-based transcription tool with automatic audio segmentation

Goal: Integrate Echo's audio segmentation into Viveka to handle long recordings better.

---

## What Each System Does

### Viveka AI
- Upload audio or record live
- Get transcription in original language + English translation + phonetic transliteration
- Auto-generates research artifacts (Evidence Matrix, Context Matrix, Mechanism Chains, Hotspots)
- User login, admin panel, PDF export, cloud storage
- Works best with files under 20 minutes

### Echo
- Upload audio file
- Backend automatically splits long files into segments
- Processes each segment in parallel
- Joins results back together
- Can handle 1+ hour recordings
- No login, no analysis — just transcription

---

## Architecture

### Viveka AI Flow
```
User → Upload Audio → Gemini AI (whole file) → Transcription + Analysis → PDF/Storage
```

### Echo Flow
```
User → Upload Audio → Split into segments → Process each in parallel → Join → Output
```

---

## Comparison

| | Viveka AI | Echo |
|---|---|---|
| Long audio (1 hr) | Struggles/times out | Handles well |
| AWESOME analysis | Yes | No |
| User accounts | Yes | No |
| PDF export | Yes | No |
| Processing | Sequential | Parallel |
| Speed (30 min file) | 10-15 min | 3-5 min |

---

## Current Issues in Viveka AI Code

After code review, the findings are summarized below.

| Category | Finding | Impact | Priority | Recommended Fix |
|---|---|---|---|---|
| Critical | Admin route is protected only by login, not role | Non-admin users can open admin pages | High | Add role-based guard for admin routes |
| Critical | Multi-language PDF path regressed in active export flow | Native script fidelity can break in exported files | High | Restore Noto-font based export path in active code |
| Critical | Long audio is processed in single pass | Timeouts and failures on larger files | High | Add segmentation + parallel processing |
| Security | API keys are exposed in client build-time config | Secrets can be extracted from browser bundle | High | Move keys to backend proxy and rotate keys |
| Security | Auth token stored in localStorage | Higher XSS token theft risk | Medium | Move auth to secure httpOnly cookie flow |
| Important | Progress bar is timer-based, not stage-based | Misleading UX and user confusion | Medium | Tie progress to real stages/events |
| Important | Google Script sync uses no-cors mode | No reliable success/failure confirmation | Medium | Use CORS-enabled endpoint or backend relay |
| Improvement | STT and analysis use same engine path | Higher cost and lower control for long audio | Medium | Use Deepgram/Sarvam for STT + Gemini for analysis |
| Improvement | Missing fallback UX when one engine fails | User sees generic failure and retries manually | Medium | Add structured fallback states and messages |

---

## Recommended Improvements

### 1. Add Deepgram for Speech-to-Text

Current approach uses Gemini for everything. Better approach:

**Deepgram Nova-2** for transcription:
- Much faster (real-time)
- Better accuracy for Indian accents
- Built-in speaker diarization
- Handles streaming audio
- Cheaper than Gemini for pure STT

**Gemini** for analysis only:
- Send text (not audio) for AWESOME artifacts
- Faster, cheaper, more reliable

Alternative STT options:
- **Sarvam AI** — Built specifically for Indian languages
- **OpenAI Whisper** — Open source, multilingual
- **AssemblyAI** — Good speaker detection

### 2. Add Audio Segmentation (from Echo)

```
Audio Input
    ↓
Check duration
    ↓
< 20 min?  →  Direct to Gemini (current flow)
    ↓
≥ 20 min?  →  Split into 5-min segments
              Process in parallel
              Merge results
              Send text to Gemini for analysis
```

### 3. Fix the Critical Bugs

- Move API key to backend (never expose in frontend)
- Add admin role check on admin routes
- Restore Noto fonts for Indian script PDF
- Fix model name typo

### 4. Better Progress Tracking

Replace fake timer with real stages:
1. Uploading (actual upload progress)
2. Processing segment 1/5, 2/5... (real progress)
3. Generating analysis
4. Done

---

## Integration Plan

**Phase 1** — Fix critical bugs (1-2 days)

**Phase 2** — Add audio segmentation + parallel processing (3-5 days)

**Phase 3** — Integrate Deepgram for STT (2-3 days)

**Phase 4** — Keep Gemini for AWESOME analysis only (1 day)

---

## Expected Results

| Metric | Current | After Integration |
|---|---|---|
| Max duration | ~20 min | 1+ hour |
| Speed (30 min file) | 10-15 min | 3-5 min |
| Reliability | Sometimes fails | Stable |
| User experience | Manual splitting | Automatic |

---

## Files in Codebase

```
Ammachi Labs/
├── App.tsx              — Main app, routing
├── types.ts             — Data types
├── components/
│   ├── FileUpload.tsx       — File upload
│   ├── LiveRecorder.tsx     — Recording
│   ├── TranscriptionCard.tsx — Results display
│   ├── LoginPage.tsx        — Auth
│   ├── AdminConsole.tsx     — Admin panel
│   └── UserProfile.tsx      — User profile
├── services/
│   ├── geminiService.ts     — AI processing (core)
│   ├── api.ts               — Backend API calls
│   ├── storageService.ts    — Google Sheets sync
│   └── minio.service.ts     — File storage
└── code.js                  — Google Apps Script
```

---

## Summary

Echo solves Viveka's biggest problem (long audio handling). The integration is straightforward — add segmentation logic, process in parallel, merge results, then run AWESOME analysis on the combined text.

Adding Deepgram or Sarvam AI for the speech-to-text step would further improve speed and accuracy, especially for Indian languages.
