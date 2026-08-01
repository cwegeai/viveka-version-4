# Viveka AI Provider Cost Analysis Report

## Gemini API, Deepgram Speech-to-Text, and Redis Queue Cost Assessment

Prepared for Ammachi Labs  
Project: Viveka AI  
Report date: 18 June 2026

---

## 1. Executive Summary

This report provides a professional cost assessment for the current Viveka AI implementation, focusing on the three external services that materially affect operating cost:

1. Gemini API
2. Deepgram Speech-to-Text
3. Redis Cloud

Unlike the reference Gemini billing report used as a formatting benchmark, this document is not an invoice audit. It is a forward-looking architecture and pricing analysis based on:

- the current Viveka AI codebase
- the active backend configuration in this workspace
- official Gemini pricing
- official Deepgram pricing
- the Redis Cloud screenshots provided for the current 30 MB free-tier database and upgrade options

### Key conclusions

- Deepgram is the primary variable cost driver in the current architecture.
- Gemini cost is comparatively low because it is only invoked for shorter audio and it processes text, not raw audio, in the current backend flow.
- Redis is currently a zero-cost service because the project is operating on the 30 MB free tier.
- The most important hidden Deepgram cost driver is chunk overlap for long files. The current 10-minute chunking strategy with 60-second overlap adds roughly 10% more billable STT duration on long recordings.
- The most important hidden Gemini cost driver is prompt duplication. The current prompt payload includes the merged transcript plus turn-level copies of the same text, which increases token volume beyond the raw transcript length.

### Overall cost position

For the present implementation, the cost hierarchy is:

1. Deepgram transcription
2. Gemini qualitative artifact generation
3. Redis queue and progress storage

In practical terms, Redis is currently operationally important but financially negligible, while Deepgram is the service that will dominate monthly spend as usage grows.

---

## 2. Solution Scope and Current Architecture

### 2.1 What the system does

Viveka AI is a research-oriented audio transcription and qualitative analysis platform. The current implementation accepts uploaded or recorded audio, transcribes it with Deepgram, merges transcript chunks when long audio is split, and then optionally sends the merged transcript to Gemini to generate structured research artifacts.

### 2.2 Current provider usage in this project

The current backend implementation uses:

- Deepgram `nova-3` with `language=multi`
- Deepgram pre-recorded `/v1/listen` requests
- Smart formatting enabled
- Punctuation enabled
- Speaker diarization enabled
- Gemini `gemini-2.5-flash`
- Redis Cloud for queue and progress coordination only

### 2.3 Current runtime rules that materially affect cost

The current code and environment produce the following operational behavior:

| Item | Current implementation behavior |
| --- | --- |
| Direct Deepgram path | Used for files up to 20 minutes |
| Gemini auto-generation | Used only for audio up to 15 minutes |
| Long-audio chunking | 10-minute chunks with 60-second overlap |
| Redis usage | Used only for uploads up to 30 MB |
| Files above 30 MB | Process inline, without Redis queue dependency |
| Redis storage role | Queue metadata and progress events only, not media storage |

### 2.4 Architecture-specific cost implications

This architecture has four direct cost effects:

1. Every uploaded file incurs Deepgram STT cost.
2. Only shorter files incur Gemini artifact-generation cost by default.
3. Long files above 20 minutes are chunked, which increases billed Deepgram minutes because overlap is transcribed more than once.
4. Redis does not scale with audio duration directly; it scales with transient queue volume and progress retention.

---

## 3. Data Sources and Methodology

### 3.1 Data sources used

This report is based on the following sources:

- Current project code and backend configuration in this workspace
- Official Gemini pricing page
- Official Deepgram pricing page
- Redis Cloud screenshots supplied on 18 June 2026
- Reference document: `Gemini_API_Cost_Analysis_Report.docx.pdf`

### 3.2 Pricing basis

This report uses current public list pricing and a planning exchange rate of:

| Item | Value |
| --- | --- |
| Planning FX rate | ₹90 per USD |

This exchange rate is used only for budgeting clarity. Actual billed INR will vary with payment method, tax treatment, and the provider's applied conversion rate.

### 3.3 Important methodological note

This is a forecast and architecture-cost report, not a historical billing report. Therefore:

- figures for Deepgram and Gemini are modeled from vendor list prices
- figures for Redis are taken from the screenshots you provided
- taxes are excluded unless explicitly noted
- totals should be treated as operating estimates, not invoice commitments

---

## 4. Current Configuration Snapshot

The current implementation relevant to cost is summarized below.

| Category | Current setting |
| --- | --- |
| STT provider | Deepgram |
| STT model | Nova-3 multilingual |
| STT request type | Pre-recorded REST transcription |
| Deepgram language mode | `multi` |
| Smart formatting | Enabled |
| Speaker diarization | Enabled |
| Gemini model | Gemini 2.5 Flash |
| Gemini on long files | Disabled automatically above 15 minutes |
| Direct Deepgram threshold | 20 minutes |
| Chunk duration | 10 minutes |
| Chunk overlap | 60 seconds |
| Redis free tier | 30 MB |
| Redis queue cap in current app | Files up to 30 MB |
| Redis observed usage in screenshot | 2.3 MB of 30 MB, or 7.8% |

---

## 5. Gemini API Cost Analysis

### 5.1 What Gemini is used for in Viveka AI

Gemini is not being used as the speech-to-text engine in the current architecture. Deepgram handles transcription first. Gemini is used after transcript merge to generate structured qualitative analysis artifacts.

This is important because it means Gemini cost in this project is primarily:

- text input cost
- text output cost

It is not primarily:

- raw audio input cost
- live audio output cost
- grounding cost

### 5.2 Current Gemini model in use

The backend is currently configured to use:

| Item | Value |
| --- | --- |
| Gemini model | `gemini-2.5-flash` |
| Invocation style | standard text generation request |
| Grounding | not used in current backend flow |
| Context caching | not implemented in current backend flow |

### 5.3 Official pricing relevant to this project

Based on the official Gemini pricing page, the relevant paid-tier prices for `gemini-2.5-flash` are:

| Cost component | Official price |
| --- | --- |
| Text, image, video input | $0.30 per 1,000,000 tokens |
| Audio input | $1.00 per 1,000,000 tokens |
| Output tokens | $2.50 per 1,000,000 tokens |
| Context caching input | $0.03 per 1,000,000 tokens |
| Context caching storage | $1.00 per 1,000,000 tokens per hour |

### 5.4 Why Gemini cost is relatively low in this project

Gemini cost is limited by design because:

1. Gemini is called only after transcription is complete.
2. Gemini is automatically skipped for files longer than 15 minutes.
3. The current usage pattern is text-in, text-out rather than audio-in, audio-out.

### 5.5 The hidden Gemini cost driver in the current code

Although Gemini is not the dominant cost driver, the current prompt design is more expensive than it needs to be.

The backend sends:

- the full merged transcript
- the turn list
- the same turn text repeated as `original`
- the same turn text repeated as `transliterated`
- the same turn text repeated as `translated`

This means the same transcript content is represented multiple times in the request payload before Gemini even starts generating a response.

As a result, actual Gemini input tokens are materially higher than the raw transcript size alone.

### 5.6 Gemini cost estimate per file

Because token usage depends on transcript length and output verbosity, the most practical way to model cost is by scenario band.

For planning purposes, this report uses conservative app-specific assumptions:

- a 10-minute research interview produces a modest transcript payload and analysis output
- a 15-minute file produces proportionally larger structured output
- files above 15 minutes do not trigger Gemini automatically in the current system

| Scenario | Estimated Gemini input/output profile | Estimated Gemini cost |
| --- | --- | --- |
| 10-minute file | short transcript + structured artifact output | about $0.0124, or about ₹1.12 |
| 15-minute file | larger transcript + larger artifact output | about $0.0186, or about ₹1.67 |
| 30-minute file | skipped automatically by current policy | ₹0 |
| 60-minute file | skipped automatically by current policy | ₹0 |

### 5.7 Gemini free-tier note

Google's Gemini Developer API currently offers a free tier with limited access and rate limits. If usage remains within free-tier allowances, real billed Gemini cost may stay at zero for some period. However, this report uses paid-tier pricing because that is the correct basis for production planning.

---

## 6. Deepgram Cost Analysis

### 6.1 What Deepgram is used for in Viveka AI

Deepgram is the core operational engine for transcription. Every uploaded file in the current implementation goes through Deepgram, either directly or via chunked processing.

### 6.2 Current Deepgram request profile

The current backend request uses:

| Item | Current value |
| --- | --- |
| Model | Nova-3 |
| Language mode | Multilingual |
| Request type | Pre-recorded transcription |
| Smart formatting | Enabled |
| Punctuation | Enabled |
| Speaker diarization | Enabled |

### 6.3 Official pricing relevant to this project

Based on the official Deepgram pricing page, the relevant pay-as-you-go prices for the current Viveka AI request shape are:

| Cost component | Official price |
| --- | --- |
| Nova-3 multilingual, pre-recorded | $0.0092 per minute |
| Speaker diarization add-on | $0.0020 per minute |
| Smart formatting | Included |

### 6.4 Effective Deepgram rate for the current project

Because Viveka AI currently enables speaker diarization for transcription, the effective base STT rate is:

$$
0.0092 + 0.0020 = 0.0112\text{ USD per minute}
$$

That is the most relevant Deepgram planning rate for the current app.

### 6.5 Deepgram cost per hour

| Metric | Value |
| --- | --- |
| Effective rate per minute | $0.0112 |
| Effective rate per hour | $0.6720 |
| Effective rate per hour in INR | about ₹60.48 |

### 6.6 The hidden Deepgram cost driver: chunk overlap

Long files above 20 minutes are chunked into 10-minute segments with 60 seconds of overlap. That means parts of the same source audio are sent to Deepgram more than once.

This improves merge quality, but it increases billable transcription minutes.

For long recordings, the total billed duration is approximately:

$$
	ext{Original duration} + (\text{overlap} \times (\text{number of chunk boundaries}))
$$

In the current configuration, this produces roughly 10% additional billable duration on many long files.

### 6.7 Deepgram cost estimate per file

| Scenario | Original duration | Estimated Deepgram billed duration | Estimated Deepgram cost | Estimated Deepgram cost in INR |
| --- | --- | --- | --- | --- |
| Short file | 10 min | 10 min | $0.1120 | about ₹10.08 |
| Short file | 15 min | 15 min | $0.1680 | about ₹15.12 |
| Long file | 30 min | 33 min | $0.3696 | about ₹33.26 |
| Long file | 60 min | 66 min | $0.7392 | about ₹66.53 |

### 6.8 Deepgram free-credit note

Deepgram's pricing page indicates a $200 free credit for new pay-as-you-go usage. That is useful for pilot validation, but it should not be treated as a permanent operating assumption.

### 6.9 Growth-plan note

If Viveka AI grows materially, the Deepgram Growth plan can reduce Nova-3 multilingual and diarization rates. However, the current report is based on pay-as-you-go because that is the most appropriate present-state assumption.

---

## 7. Redis Cost Analysis

### 7.1 What Redis is used for in Viveka AI

Redis is not used as the system of record for transcripts or uploaded audio. In the current implementation it is used as a lightweight operational layer for:

- queue metadata
- background job coordination
- progress-event storage for SSE streaming

### 7.2 Current Redis operating mode

The current implementation now routes only uploads up to 30 MB through the Redis-backed queue path. Files above 30 MB bypass Redis and run through the backend pipeline inline.

This is a financially and operationally important design decision because it prevents large uploads from exhausting the free-tier Redis memory allocation.

### 7.3 Current Redis free-tier position

From the Redis Cloud screenshots you provided:

| Item | Current observed value |
| --- | --- |
| Current plan | 30 MB free tier |
| Observed usage | 2.3 MB of 30 MB |
| Utilization | 7.8% |

### 7.4 Current Redis cost

| Item | Current cost |
| --- | --- |
| Redis free-tier operating cost | $0 |
| Redis free-tier operating cost in INR | ₹0 |

### 7.5 Redis upgrade options from your screenshots

The upgrade options shown in your screenshots indicate the following reference prices:

| Redis tier | Screenshot price | Approximate monthly INR |
| --- | --- | --- |
| 30 MB | free | ₹0 |
| 250 MB | about $5/month or $0.007/hour | about ₹450/month |
| 1 GB | about $0.025/hour | about ₹1,620/month |
| 2.5 GB | about $0.049/hour | about ₹3,150/month |

### 7.6 Redis cost interpretation for this project

Redis is not currently a volume-based cost problem. It is a capacity and operational-safety concern.

As long as:

- queue payloads remain small
- progress events are cleared properly
- only files up to 30 MB use Redis

the free tier is likely sufficient for current development and early pilot usage.

---

## 8. Combined Cost Scenarios for Viveka AI

### 8.1 Single-file cost scenarios

The table below combines current Deepgram and Gemini logic for representative uploads.

| Scenario | Deepgram cost | Gemini cost | Redis cost | Total cost | Total cost in INR |
| --- | --- | --- | --- | --- | --- |
| 10-minute file with transcript + artifacts | $0.1120 | $0.0124 | $0 | $0.1244 | about ₹11.20 |
| 15-minute file with transcript + artifacts | $0.1680 | $0.0186 | $0 | $0.1866 | about ₹16.79 |
| 30-minute file, transcript only by default | $0.3696 | $0 | $0 | $0.3696 | about ₹33.26 |
| 60-minute file, transcript only by default | $0.7392 | $0 | $0 | $0.7392 | about ₹66.53 |

### 8.2 Monthly planning scenarios

| Scenario | Workload assumption | Deepgram | Gemini | Redis | Estimated monthly total |
| --- | --- | --- | --- | --- | --- |
| Pilot research workload | 100 interviews of 10 minutes each | about $11.20 | about $1.24 | $0 | about $12.44, or about ₹1,120 |
| Moderate field workload | 200 interviews of 30 minutes each | about $73.92 | $0 by default | $0 | about $73.92, or about ₹6,653 |
| Redis upgrade contingency | free tier exceeded, move to 250 MB | unchanged | unchanged | about $5/month | add about ₹450/month |

### 8.3 Cost dominance by service

For the current architecture, the cost pattern is clear:

- Deepgram dominates cost in both short-file and long-file scenarios.
- Gemini is a secondary cost driver and only appears on shorter files.
- Redis remains free unless operational scale forces a tier upgrade.

---

## 9. Major Cost Drivers and Risk Factors

### 9.1 Deepgram cost drivers

The main Deepgram cost drivers are:

- total transcription minutes
- multilingual pricing rather than monolingual pricing
- diarization enabled on every request
- overlap-induced duplicate minutes on long files

### 9.2 Gemini cost drivers

The main Gemini cost drivers are:

- input token duplication in the current prompt payload
- structured output verbosity
- whether Gemini remains enabled only for shorter files

### 9.3 Redis risk factors

The main Redis risk factors are not pricing, but stability and memory pressure:

- retained progress events can accumulate if not cleared promptly
- the 30 MB free tier can fail operationally before it becomes a billing issue
- queue-based architectures become fragile if Redis hits max memory or eviction limits

---

## 10. Optimization Recommendations

### 10.1 High-impact recommendations

#### A. Keep Gemini disabled by default for long files

This is already the correct design for cost control. It prevents long audio from incurring unnecessary artifact-generation cost and keeps the dominant spend in the STT layer only.

#### B. Reduce Gemini prompt duplication

The current Gemini request duplicates transcript text across multiple fields. Replacing that with a leaner structure would reduce input tokens with little or no loss in analysis quality.

Expected benefit:

- lower Gemini input-token cost
- lower latency
- less JSON overhead

#### C. Use monolingual Deepgram where multilingual detection is not required

If a workload is known to be primarily one language, monolingual Nova-3 pre-recorded pricing is cheaper than multilingual Nova-3 pre-recorded pricing.

This matters most for large-volume workloads.

### 10.2 Medium-impact recommendations

#### D. Disable diarization for single-speaker recordings when business logic allows it

Diarization currently adds $0.0020 per minute. If many research recordings are single-speaker or do not require speaker segmentation, disabling diarization selectively could reduce transcription cost meaningfully.

#### E. Revisit overlap duration after quality testing

The 60-second overlap improves merge quality but adds billable transcription minutes. If 30-second overlap proves sufficient in practice, long-file Deepgram cost would fall.

#### F. Consider Gemini caching or asynchronous batch strategies later

Gemini Batch API and context caching can reduce cost in some workloads, but only if the product accepts asynchronous artifact-generation behavior and repeated prompt structure.

### 10.3 Redis-specific recommendations

#### G. Keep Redis on the free tier while possible

The current 30 MB limit is acceptable for the current design if Redis remains a lightweight queue and progress store only.

#### H. Upgrade to 250 MB only when operational evidence justifies it

The 250 MB tier appears to be the most reasonable first paid step. It materially improves operational headroom while keeping monthly infrastructure cost modest.

---

## 11. Monitoring and Governance Recommendations

To maintain cost control, the following monitoring practices are recommended.

### 11.1 Gemini monitoring

- track input vs output token ratios per request
- track average output length per file category
- log whether Gemini was skipped due to duration threshold

### 11.2 Deepgram monitoring

- track original audio duration vs billed chunk duration
- track percentage overhead created by overlap
- separate multilingual and monolingual traffic where possible
- measure diarization usage against actual business need

### 11.3 Redis monitoring

- monitor memory utilization daily
- track queue depth and event-retention size
- alert when Redis free-tier usage exceeds 70% of capacity

---

## 12. Final Assessment

The current Viveka AI implementation is financially sensible for a research application, but the cost profile is highly asymmetric.

### Final assessment by provider

| Provider | Cost impact | Comment |
| --- | --- | --- |
| Deepgram | High | Primary cost driver in nearly every production scenario |
| Gemini | Low to moderate | Secondary cost layer, mainly for short files only |
| Redis | Minimal today | Operational concern first, billing concern second |

### Bottom-line conclusion

If the current architecture remains unchanged:

- Deepgram will account for the majority of monthly spend.
- Gemini will remain manageable if the 15-minute auto-generation threshold is preserved.
- Redis can remain free unless queue volume or event retention grows materially.

The single most important cost-control action for this project is not a Redis change. It is disciplined control of transcription minutes and feature flags in the Deepgram layer, followed by prompt-efficiency improvements in the Gemini layer.

---

## 13. Appendix

### 13.1 Pricing sources used

- Official Gemini Developer API pricing page, retrieved during report preparation
- Official Deepgram pricing page, retrieved during report preparation
- Redis Cloud screenshots provided by project owner on 18 June 2026

### 13.2 Project assumptions used in this report

| Assumption | Value |
| --- | --- |
| FX planning rate | ₹90/USD |
| Deepgram model | Nova-3 multilingual, pre-recorded |
| Deepgram add-on | Speaker diarization enabled |
| Gemini model | Gemini 2.5 Flash |
| Gemini threshold | enabled only up to 15 minutes |
| Direct STT threshold | 20 minutes |
| Long-file chunk size | 10 minutes |
| Long-file overlap | 60 seconds |
| Redis free-tier size | 30 MB |
| Redis usage scope | queue and progress data only |
| Redis queue cap in current app | files up to 30 MB |

### 13.3 Interpretation note

This document is intended to support budgeting, stakeholder communication, and provider planning for Viveka AI. It should be updated when any of the following change:

- Gemini model selection
- Deepgram model or feature flags
- Redis tier or queue policy
- chunk duration or overlap strategy
- threshold for Gemini artifact generation

