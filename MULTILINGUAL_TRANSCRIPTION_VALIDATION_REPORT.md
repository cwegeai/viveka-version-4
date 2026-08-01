# Multilingual Transcription Validation Report

## Scope

This update hardens the Deepgram transcription pipeline for multilingual and code-switched conversations by:

- changing the default Deepgram model from `nova-2` to `nova-3`
- adding `language=multi` to the Deepgram request
- preserving documented language metadata through backend parsing, chunk merge, API responses, frontend normalization, and sync payloads
- adding automated backend tests for monolingual and code-switched scenarios

## Files Modified

Backend:

- `backend/app/config.py`
- `backend/app/models.py`
- `backend/app/deepgram_service.py`
- `backend/app/merge_engine.py`
- `backend/app/gemini_service.py`
- `backend/tests/test_multilingual_transcription.py` (new)

Frontend:

- `types.ts`
- `services/transcriptionService.ts`
- `services/storageService.ts`

## Exact Code Changes

### 1. Deepgram request upgrade

Default settings now use:

```text
model=nova-3
language=multi
smart_format=true
punctuate=true
diarize=true
filler_words=false
```

This preserves the existing formatting and diarization behavior while enabling Deepgram's documented multilingual code-switch mode.

### 2. New backend models and fields

Added `TranscriptWord` with:

- `word`
- `punctuated_word`
- `start_time`
- `end_time`
- `confidence`
- `speaker`
- `language`
- `language_metadata`

Extended `SpeakerSegment` with:

- `language`
- `languages`
- `words`
- `language_metadata`

Extended `ChunkTranscript` with:

- `detected_language`
- `languages`
- `words`
- `language_metadata`

Extended `MergedTranscript` with:

- `detected_language`
- `languages`
- `words`
- `language_metadata`

Extended `TranscriptTurn` with:

- `language`
- `languages`
- `words`
- `language_metadata`

Extended `FinalResult` with:

- `languages`
- `language_metadata`
- existing `detected_language` retained
- existing `chunk_results` retained

### 3. Deepgram response parsing

The parser now preserves documented and observed language-related fields instead of collapsing to a single fallback string.

Parsed fields:

- `results.channels[0].detected_language`
- `results.channels[0].language`
- `results.channels[0].alternatives[0].language`
- `results.channels[0].alternatives[0].languages`
- `results.channels[0].alternatives[0].words[].language`
- any additional `*language*` keys found in channel, alternative, or word objects

### 4. Merge logic changes

The chunk merge path now:

- keeps `languages` as an ordered set across chunks
- preserves chunk-level `language_metadata`
- preserves word-level language tags across chunk boundaries
- uses word-overlap trimming when possible so language-tagged words are not lost unnecessarily
- avoids collapsing the merged result to a frequency-based dominant language when richer ordered metadata exists

### 5. API response and frontend preservation

The backend `FinalResult` now exposes multilingual metadata directly.

The frontend no longer strips these fields during SSE normalization. The normalized result now preserves:

- `detected_language`
- `languages`
- `language_metadata`
- `chunk_results`

The sync payload to the storage backend now also includes:

- transcript-level language metadata
- per-turn languages
- per-turn words with language tags

## Deepgram Request Payload Sent

```json
{
  "model": "nova-3",
  "language": "multi",
  "smart_format": "true",
  "punctuate": "true",
  "diarize": "true",
  "filler_words": "false"
}
```

## Architecture Diagram

```mermaid
flowchart TD
    A[Upload Audio] --> B[FastAPI /api/transcribe]
    B --> C[Deepgram Request\nmodel=nova-3\nlanguage=multi]
    C --> D[Parse Deepgram Response]
    D --> D1[ChunkTranscript\ndetected_language\nlanguages\nwords[].language\nlanguage_metadata]
    D1 --> E[Chunk Merge]
    E --> E1[Preserve ordered languages]
    E --> E2[Preserve word-level tags]
    E --> E3[Preserve chunk metadata]
    E1 --> F[MergedTranscript]
    E2 --> F
    E3 --> F
    F --> G[FinalResult Builder]
    G --> H[SSE result/complete events]
    H --> I[Frontend normalization]
    I --> J[UI state + optional storage sync]
```

## Sample API Responses

### Sample parsed chunk response

Representative English + Hindi code-switch example after parsing:

```json
{
  "chunk_id": 1,
  "transcript": "I worked at Infosys and फिर I joined another company.",
  "language": "en",
  "detected_language": "en",
  "languages": ["en", "hi"],
  "words": [
    { "word": "I", "language": "en" },
    { "word": "worked", "language": "en" },
    { "word": "Infosys", "language": "en" },
    { "word": "फिर", "language": "hi" },
    { "word": "joined", "language": "en" }
  ],
  "language_metadata": {
    "channel": { "detected_language": "en" },
    "alternative": { "languages": ["en", "hi"] }
  }
}
```

### Sample final API result

Representative transcript-first result emitted by the backend:

```json
{
  "turns": [
    {
      "speaker": "Speaker 1",
      "original": "I worked at Infosys and फिर I joined another company.",
      "language": "en",
      "languages": ["en", "hi"],
      "words": [
        { "word": "I", "language": "en" },
        { "word": "फिर", "language": "hi" }
      ]
    }
  ],
  "detected_language": "en",
  "languages": ["en", "hi"],
  "language_metadata": {
    "chunks": [
      {
        "channel": { "detected_language": "en" },
        "alternative": { "languages": ["en", "hi"] }
      }
    ]
  },
  "chunk_results": [
    {
      "language": "en",
      "detected_language": "en",
      "languages": ["en", "hi"]
    }
  ]
}
```

## Language Metadata Captured

The updated code preserves these metadata layers:

- transcript-level primary language
- transcript-level detected language
- transcript-level ordered language list
- segment-level primary language
- segment-level ordered language list
- word-level language tags
- chunk-level language metadata containers
- alternative-level language metadata containers

## Automated Test Coverage

Test command:

```text
python -m unittest backend.tests.test_multilingual_transcription
```

Observed result:

```text
Ran 16 tests in 0.111s
OK
```

### Scenario Results

| ID | Scenario | Coverage | Result |
| --- | --- | --- | --- |
| A | English only | parser preserves `en` language metadata | Pass |
| B | Hindi only | parser preserves `hi` language metadata | Pass |
| C | Tamil only | parser preserves `ta` language metadata | Pass |
| D | Telugu only | parser preserves `te` language metadata | Pass |
| E | Malayalam only | parser preserves `ml` language metadata | Pass |
| F | Kannada only | parser preserves `kn` language metadata | Pass |
| G | Marathi only | parser preserves `mr` language metadata | Pass |
| H | English + Hindi code-switching | parser preserves ordered `en`, `hi` and word tags | Pass |
| I | English + Tamil code-switching | parser preserves ordered `en`, `ta` and word tags | Pass |
| J | English + Telugu code-switching | parser preserves ordered `en`, `te` and word tags | Pass |
| K | English + Malayalam code-switching | parser preserves ordered `en`, `ml` and word tags | Pass |
| L | English + Kannada code-switching | parser preserves ordered `en`, `kn` and word tags | Pass |
| M | Triple-language switching | parser preserves ordered `en`, `ta`, `te` and word tags | Pass |
| N | Deepgram request defaults | verifies `nova-3` and `language=multi` | Pass |
| O | Chunk merge preservation | verifies merged output keeps multilingual metadata | Pass |
| P | Final result exposure | verifies transcript-first API result includes language metadata | Pass |

## Validation Commands Run

- `python -m unittest backend.tests.test_multilingual_transcription`
- `python -m compileall backend/app backend/tests`
- `npm run build`

All completed successfully.

## Git Diff Summary

Tracked-file diff summary for this task's frontend preservation changes:

```text
 services/storageService.ts       |  23 +-
 services/transcriptionService.ts | 563 +++++++--------------------------------
 types.ts                         |  46 ++++
 3 files changed, 167 insertions(+), 465 deletions(-)
```

Additional multilingual backend files are currently untracked in this repo state and were changed or added as part of this work:

- `backend/app/config.py`
- `backend/app/models.py`
- `backend/app/deepgram_service.py`
- `backend/app/merge_engine.py`
- `backend/app/gemini_service.py`
- `backend/tests/test_multilingual_transcription.py`

## Remaining Limitations

1. The automated tests validate the code against Deepgram's documented response structure, not against live Deepgram audio calls for all listed languages.
2. Deepgram's current multilingual `language=multi` documentation explicitly covers a multilingual set that includes English and Hindi, but does not document Tamil, Telugu, Malayalam, Kannada, or Marathi as part of the multilingual code-switching set.
3. Because of that provider limitation, successful preservation of `ta`, `te`, `ml`, `kn`, or `mr` metadata in this code means the pipeline can retain those fields if Deepgram returns them. It does not prove Deepgram will reliably emit them for mixed-language Indian utterances in production.
4. The current merge path preserves rich language metadata, but UI components still render the transcript primarily as text and do not yet visualize code-switch boundaries or per-word language tags.

## Reliability Assessment For Mixed Indian-Language Utterances

### What is now true in this codebase

- The application no longer drops Deepgram language metadata.
- If Deepgram returns `languages` and `words[].language`, the backend and frontend now preserve them end to end.
- The API request is now configured correctly for Deepgram's multilingual mode.

### What is not yet proven

- This implementation does not prove Deepgram returns reliable word-level language metadata for English + Tamil, English + Telugu, English + Malayalam, English + Kannada, or similar mixed Indian-language utterances.
- Based on the current Deepgram documentation inspected during implementation, that reliability remains uncertain outside the provider's documented multilingual set.

### Recommendation

For production-grade English + Indian regional language code-switching beyond English + Hindi, add a live evaluation stage with real audio and expected word-level language labels. If reliability is insufficient, use a segmented language-identification plus per-language STT routing architecture rather than depending on a single `language=multi` request.