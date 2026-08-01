# Viveka AI

## System Review and Implementation Report

**Project:** Viveka AI - Qualitative Verbatim Specialist  
**Date:** June 2026

---

## Executive Summary

Viveka AI is a research-oriented transcription and qualitative analysis platform designed for field recordings, interviews, and spoken narrative data. The system accepts uploaded or live-recorded audio, converts it into structured multi-layer transcript output, and generates research artifacts for downstream analysis and reporting.

The recent implementation work focused on stabilizing the product, improving the transcription pipeline, and resolving the long-audio processing problem that had become the most visible operational issue. The application now uses Deepgram for speech-to-text and Azure OpenAI for post-transcription qualitative synthesis. In addition, the long-audio path has been redesigned so that large files are automatically segmented, processed in smaller units, and merged back into one coherent transcript.

The most important outcome from this phase is that long audio is no longer treated as a single fragile request. In live testing, a 21-minute audio sample successfully entered the segmented processing path, advanced through multiple chunks, and completed to the final result screen with transcript and artifact output. This represents a meaningful improvement in reliability compared with the earlier single-pass behavior.

From a delivery standpoint, the system is now substantially stronger in three areas: operational clarity, long-audio resilience, and end-user workflow continuity. The remaining work is narrower and more implementation-specific, rather than structural.

---

## 1. Purpose of the System

Viveka AI is not a generic speech-to-text tool. It is built as a qualitative research workflow tool with the following goals:

- capture field audio through upload or live recording
- generate verbatim transcript output
- preserve multiple text layers where needed: original transcript, phonetic/transliterated text, and translated text
- generate structured qualitative summaries and research artifacts
- allow authenticated access for users and administrators
- export outputs as formal dossiers for review and archival use

In practical terms, the application is positioned as a researcher-facing platform rather than a pure transcription engine.

---

## 2. Current System Scope

The current codebase is a frontend-first React and Vite application that connects to hosted services for authentication, file management, storage sync, and AI processing.

### Core user-facing capabilities

- secure login and registration flow
- user profile and history view
- admin console access for privileged users
- file upload workflow for existing recordings
- live recording workflow from the browser
- transcript viewing and structured result presentation
- PDF dossier export
- cloud sync to external spreadsheet and drive endpoints

### Current AI flow

- Deepgram is used for speech-to-text
- Azure OpenAI is used for qualitative artifact synthesis from the resulting transcript
- long files are routed through chunk-based processing rather than a single direct request

---

## 3. High-Level Architecture

The current implementation can be understood as a workflow-driven architecture composed of six functional layers.

### 3.0 System architecture at a glance

```text
User
  |
  +-- Login / Session Access
  |
  +-- Audio Input
      |-- File Upload
      |-- Live Recording
			|
			v
      Frontend Processing Controller
			|
			+-- Short Audio Path ---------------------> Deepgram STT
			|
			+-- Long Audio Path
						|-- Duration Check
						|-- Chunk Generation
						|-- Segment Transcription
						|-- Merge and Normalize Transcript
																|
																v
												 Azure OpenAI Analysis
																|
																v
								 Transcript + AWESOME Artifacts + Summary
																|
					+---------------------+----------------------+------------------+
					|                     |                      |
					v                     v                      v
		Result Screen         PDF Dossier            External Sync
																								 (Sheets / Drive)
```

### 3.1 Architectural interpretation

The architecture follows a layered, workflow-driven frontend model. The browser acts as the orchestration surface for user interaction, audio submission, status tracking, and result presentation, while external services handle transcription, analysis, authentication, and data sync.

This separation is important because the product is not simply rendering an API response. It coordinates multiple asynchronous stages, preserves transcript structure across those stages, and presents the final output as a research-ready result rather than a raw machine transcript.

### 3.2 Presentation layer

This includes the main dashboard, login and registration pages, profile screen, admin screen, upload flow, live recorder, and transcription results card.

### 3.3 Session and access layer

The application stores authenticated session data in browser session storage and uses route guards to control access to user and admin areas.

### 3.4 Transcription and analysis layer

This is the most critical operational layer.

- short audio files are sent directly to Deepgram for transcription
- long audio files are automatically segmented into smaller WAV chunks
- chunk outputs are normalized and merged in sequence
- the combined transcript is then sent to Azure OpenAI for artifact generation

### 3.5 Export and document layer

The result view supports PDF dossier generation and audio playback alongside transcript review.

### 3.6 External sync layer

The application pushes structured output to Google Apps Script-backed endpoints for spreadsheet and drive sync.

### 3.7 Why this architecture matters

The architecture is appropriate for the current stage of the product because it keeps the user journey unified while allowing the AI tasks to be separated by responsibility. Deepgram is used where speed and transcription reliability matter most, while Azure OpenAI is used where reasoning and qualitative synthesis matter most. This division reduces unnecessary coupling and makes the system easier to evolve.

---

## 4. Current Codebase Structure

The current implementation is organized around a small set of high-value modules.

| Area | Responsibility |
|---|---|
| `App.tsx` | Main routing, dashboard behavior, session-aware workflow control |
| `components/FileUpload.tsx` | File selection, validation, restart behavior |
| `components/LiveRecorder.tsx` | Browser-based recording workflow |
| `components/TranscriptionCard.tsx` | Result display, audio playback, dossier export |
| `components/LoginPage.tsx` | Login and registration flow |
| `components/UserProfile.tsx` | User profile and recording history |
| `components/AdminConsole.tsx` | Admin-facing management view |
| `services/transcriptionService.ts` | Active transcription and artifact generation pipeline |
| `services/api.ts` | Hosted backend API integration |
| `services/storageService.ts` | Spreadsheet sync |
| `services/driveService.ts` | PDF-to-drive sync |
| `services/authStorage.ts` | Session token and user storage helpers |
| `vite.config.ts` | Frontend build configuration and provider env injection |

Taken together, these modules reflect a focused product structure: interface components handle user interaction, service modules manage external communication and orchestration, and the root application coordinates access, workflow state, and result rendering.

---

## 5. What Was Added and Improved

This section summarizes the work completed on top of the earlier codebase.

### 5.1 Provider restructuring

The earlier implementation depended heavily on Gemini-oriented processing logic. The current active path has been shifted so that:

- Deepgram handles transcription
- Azure OpenAI handles qualitative analysis from transcript text
- the dashboard now reflects Azure readiness instead of asking the user for a Gemini runtime prompt flow

This is a cleaner separation of responsibilities and a more maintainable operational model.

### 5.2 Long-audio handling redesign

This was the most important functional change.

Previously, long recordings were operationally fragile because large audio processing could stall, timeout, or become difficult to monitor. The current implementation now:

- detects long files automatically
- splits them into smaller segments
- converts segments into WAV chunks for processing
- sends chunk requests through Deepgram
- retries failed segments once
- enforces a request timeout so the UI does not wait forever
- processes up to two chunks concurrently
- merges all chunk outputs back into a single ordered transcript
- preserves timestamp continuity across the combined result

This is the change that directly addresses the earlier concern that long audio was not being processed properly.

### 5.3 Improved session and profile handling

The login and session flow now preserves more user information than before, particularly affiliation and nationality details, improving the usefulness and accuracy of the profile screen.

### 5.4 Safer route behavior

Authentication and access flow were tightened so that protected pages behave more consistently and non-admin access does not silently fall through to admin views.

### 5.5 Better failure visibility

Several silent or misleading behaviors were reduced. In particular:

- drive sync now surfaces actual response failures instead of relying on blind `no-cors` behavior
- long-audio chunk requests now fail explicitly rather than hanging indefinitely
- the dashboard presents clearer provider-state messaging

### 5.6 Output and usability refinements

The result screen now supports playback and cleaner report presentation, and the PDF export path has been preserved as part of the user-facing output workflow.

Overall, these improvements were not cosmetic in isolation. They improved system coherence by making the platform easier to operate, easier to validate, and easier to present as a serious research tool.

---

## 6. Long-Audio Processing: Specific Status

Because this was a major concern, it is worth stating separately and clearly.

### What the system does now

- files at or above the long-audio threshold are routed to segmented processing
- the file is split into smaller chunks rather than processed as a single request
- each segment is transcribed independently
- segment results are merged into one final transcript
- the merged transcript is then used for qualitative synthesis

### What was validated

A live browser test was run with a generated 21-minute speech WAV file of approximately 53 MB. This file was chosen specifically because it was:

- large enough to trigger the long-audio branch
- below the platform upload size limit
- long enough to expose chunking and merge behavior

Observed behavior during testing:

- the application entered the segmented processing path
- the status moved through multiple chunk steps rather than remaining stuck on the first chunk
- the run advanced through the later chunk stages
- the workflow reached the final result screen with transcript output and qualitative artifact content visible

### Practical conclusion

Yes, work was done on the long-audio issue, and the current code reflects that work. More importantly, the improved path was exercised in the browser and showed materially better behavior than the earlier single-pass approach.

---

## 7. Validation Performed

The following validation activities were completed during this phase.

### Build validation

- production build completed successfully using `npm run build`

### Functional validation

- registration and login flow tested
- session-aware profile access tested
- admin route behavior reviewed
- local frontend run tested successfully
- provider configuration surfaced correctly in the dashboard
- long-audio upload path tested end-to-end with a real sample file

### Runtime observations

- long-audio chunking progressed through multiple segments successfully
- Azure-based artifact generation returned structured output to the UI
- the final results screen rendered transcript and synthesis content after long-audio processing

---

## 8. Current Strengths of the System

At the end of this implementation phase, Viveka AI is strongest in the following areas.

### Research-oriented output

The platform is built around qualitative use rather than raw transcription alone. That gives it clear value in academic, field, and programmatic documentation contexts.

### Better handling of long recordings

The long-audio redesign is now one of the most important strengths in the active codebase because it reduces the chance of failure on larger recordings.

### Clearer AI pipeline separation

Using Deepgram for transcription and Azure OpenAI for artifact synthesis is operationally cleaner than using one system for every stage.

### Usable front-end workflow

The application already supports the full user path from authentication to upload, processing, result review, and export.

---

## 9. Remaining Gaps and Risks

The system is improved, but it is not fully finished. The following items remain important.

### 9.1 Spreadsheet sync mismatch

During the long-audio validation, the external sync layer returned an error indicating a payload mismatch involving `base64` or `originalFileName`. This did not stop the UI from finishing the transcription and result flow, but it means the remote spreadsheet integration still needs contract alignment.

### 9.2 Frontend exposure of provider configuration

The current frontend build still injects provider configuration at build time through Vite. This is workable for internal testing, but it is not the preferred architecture for long-term production use. A backend proxy or secure server-side relay would be better.

### 9.3 Styling/tooling cleanup

The current HTML shell still uses the Tailwind CDN path, which raises a production warning. This does not block functionality, but it should be replaced with a proper bundled Tailwind setup when the UI is stabilized.

### 9.4 External dependency sensitivity

Because the application depends on remote services for transcription, analysis, auth, and sync, operational stability is still partly determined by upstream service availability and policy limits.

---

## 10. Recommended Next Steps

The next phase should focus on completion quality rather than broad feature expansion.

### Immediate priority

1. Fix the spreadsheet sync payload contract so successful runs are archived reliably.
2. Move provider calls behind a backend relay where feasible.
3. Replace the Tailwind CDN setup with a proper build-integrated configuration.

### Near-term improvement

1. Add clearer UI messaging for partial success states, for example when transcription succeeds but sync fails.
2. Add persistent operational logging for chunk-level failures and retries.
3. Add a narrow regression test plan specifically for long-audio upload behavior.

### Strategic improvement

1. Introduce backend-managed provider orchestration so secrets are not shipped through the frontend bundle.
2. Formalize output archiving and report versioning if the tool is intended for institutional use.

---

## 11. Final Assessment

Viveka AI is now in a much stronger position than the earlier baseline. The application has a clearer AI architecture, a more reliable long-audio strategy, stronger session behavior, and a better-defined research workflow from transcription to dossier generation.

The most important concern raised during review, namely that long audio was not being processed properly, has been addressed in both code and live validation. The issue is not merely documented as fixed; it has been exercised against a real long-duration sample and shown to progress through segmented transcription successfully.

The remaining work is now narrower and more concrete. The core transcription-and-analysis workflow is functional. The next stage is to tighten the external sync contract, reduce frontend exposure of provider secrets, and complete the final production-hardening steps.

In its current form, Viveka AI presents as a credible research workflow application with clear practical value. The strongest recommendation at this stage is not a redesign, but disciplined hardening of the remaining integration edges.

---

## Appendix A: Technology Snapshot

| Layer | Current Stack |
|---|---|
| Frontend | React 19, TypeScript, Vite |
| Routing | React Router |
| Transcription | Deepgram |
| Qualitative synthesis | Azure OpenAI |
| Export | jsPDF, html2canvas |
| Auth and file APIs | Hosted backend endpoints |
| External sync | Google Apps Script endpoints |

---

## Appendix B: Suggested Title for PDF Version

**Viveka AI: System Review, Implementation Summary, and Long-Audio Processing Validation**