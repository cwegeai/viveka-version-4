# Viveka AI Version 1

Viveka AI is a research-oriented audio transcription and qualitative analysis platform built for structured field recordings, interviews, and research documentation workflows.

The application supports authenticated user access, file upload, live recording, multi-layer transcript output, PDF dossier export, and qualitative artifact generation from processed audio.

## Core Capabilities

- audio upload and browser-based live recording
- Deepgram-powered speech-to-text processing
- Azure OpenAI-based qualitative artifact synthesis
- long-audio chunking and transcript merge workflow
- transcript, transliteration, and translated output views
- PDF dossier generation for result sharing
- user profile, history, and admin workflow support

## Technology Stack

- React 19
- TypeScript
- Vite
- React Router
- jsPDF
- html2canvas
- Deepgram
- Azure OpenAI

## Local Development

### Prerequisites

- Node.js
- npm

### Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Create a local environment file and provide the required provider keys:

   ```env
   AZURE_OPENAI_ENDPOINT=...
   AZURE_OPENAI_API_VERSION=...
   AZURE_OPENAI_CHAT_DEPLOYMENT=...
   AZURE_OPENAI_API_KEY=...
   DEEPGRAM_API_KEY=...
   ```

3. Start the development server:

   ```bash
   npm run dev
   ```

4. Build for production validation when needed:

   ```bash
   npm run build
   ```

## Processing Flow

1. User uploads or records audio.
2. Short audio is sent directly to Deepgram for transcription.
3. Long audio is split into timed chunks and processed sequentially for better reliability.
4. Chunk outputs are merged into one normalized transcript.
5. Azure OpenAI generates structured qualitative artifacts from the transcript.
6. The final result can be reviewed in the UI and exported as a dossier PDF.

## Repository Notes

- local environment files are intentionally excluded from version control
- generated build output is excluded from version control
- temporary test audio artifacts are excluded from version control

## Included Documentation

- `VIVEKA_AI_SYSTEM_IMPLEMENTATION_REPORT.md` — formal implementation and validation report
- `VIVEKA_AI_vs_ECHO_COMPARATIVE_ANALYSIS.md` — earlier comparative analysis and architecture discussion
