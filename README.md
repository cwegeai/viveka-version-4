# Viveka AI Version 1

Viveka AI is a research-oriented audio transcription and qualitative analysis platform built for structured field recordings, interviews, and research documentation workflows.

The application supports authenticated user access, file upload, live recording, multi-layer transcript output, PDF dossier export, and qualitative artifact generation from processed audio.

The transcription path now runs through a server-side ECHO-style pipeline so long audio is processed by a backend worker system instead of by the browser.

## Netlify Deployment

The frontend is Netlify-ready with the included [netlify.toml](h:/Ammachi%20Labs/netlify.toml). The backend is not suitable for Netlify as-is because it depends on a long-running FastAPI process, multipart uploads, SSE progress streaming, FFmpeg, temp-file chunking, and optional Redis worker processing.

Deploy the frontend to Netlify and host the backend separately on a Python-capable service.

Frontend environment variables are now centralized in [services/config.ts](h:/Ammachi%20Labs/services/config.ts). Use [/.env.example](h:/Ammachi%20Labs/.env.example) as the frontend template.

### Netlify Frontend Steps

1. Import the repository into Netlify.
2. Keep the default build command from [netlify.toml](h:/Ammachi%20Labs/netlify.toml):

   ```bash
   npm run build
   ```

3. Keep the publish directory from [netlify.toml](h:/Ammachi%20Labs/netlify.toml):

   ```text
   dist
   ```

4. Add these frontend environment variables in Netlify before deploying:

   ```env
   VITE_TRANSCRIPTION_API_URL=https://your-backend-host.example.com
   VITE_API_BASE_URL=https://your-backend-host.example.com
   ```

5. Trigger the deploy.

### Backend Hosting Note

Host the FastAPI backend on a service such as Render, Railway, Fly.io, or a VM where Python, FFmpeg, streaming responses, and background processing are supported.

## Render Backend Deployment

The repository now includes [render.yaml](h:/Ammachi%20Labs/render.yaml) and [backend/Dockerfile](h:/Ammachi%20Labs/backend/Dockerfile) for deploying the FastAPI backend on Render with FFmpeg available inside the container.

Use [backend/.env.render.example](h:/Ammachi%20Labs/backend/.env.render.example) as the source of truth for the backend environment variables you need in Render.

### Render Steps

1. Push the latest repository changes to GitHub.
2. In Render, create a new Blueprint or Web Service from the repository.
3. If you use the Blueprint flow, Render will pick up [render.yaml](h:/Ammachi%20Labs/render.yaml) automatically.
4. Set these required environment variables in Render:

   ```env
   DEEPGRAM_API_KEY=...
   GEMINI_API_KEY=...
   DATABASE_URL=...
   VIVEKA_BACKEND_CORS=https://your-netlify-site.netlify.app
   ```

5. Optional Redis-backed small-file queueing only if you want it:

   ```env
   REDIS_URL=redis://...
   VIVEKA_BACKGROUND_JOBS_ENABLED=true
   ```

   If you do not provide `REDIS_URL`, the backend stays on the validated inline pipeline for all files.

6. Deploy the service.
7. After Render gives you the backend URL, set these in Netlify for the frontend:

   ```env
   VITE_TRANSCRIPTION_API_URL=https://your-render-service.onrender.com
   VITE_API_BASE_URL=https://your-render-service.onrender.com
   ```

### Render Notes

- The backend health check is [backend/app/main.py](h:/Ammachi%20Labs/backend/app/main.py) at `/healthz`.
- The Docker image installs `ffmpeg`, which is required by [backend/app/audio.py](h:/Ammachi%20Labs/backend/app/audio.py).
- The default [render.yaml](h:/Ammachi%20Labs/render.yaml) disables Redis-backed background jobs so the first deploy is simpler and uses the inline transcription path.

## Core Capabilities

- audio upload and browser-based live recording
- FastAPI streaming upload backend
- Redis-backed background worker orchestration for larger files
- Deepgram speech-to-text processing
- Gemini-based qualitative artifact synthesis after transcript merge for shorter files
- FFmpeg normalization, chunking, and overlap-aware merge workflow
- transcript, transliteration, and translated output views
- PDF dossier generation for result sharing
- user profile, history, and admin workflow support

## Technology Stack

- React 19
- TypeScript
- Vite
- React Router
- FastAPI
- FFmpeg
- Deepgram
- Gemini
- jsPDF
- html2canvas

## Local Development

### Prerequisites

- Node.js
- npm
- Python 3.11+
- FFmpeg and ffprobe on PATH
- Redis when using background job mode for larger files

### Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Install backend dependencies:

   ```bash
   npm run backend:install
   ```

3. Create a frontend local environment file and point it at the backend API:

   ```env
   VITE_TRANSCRIPTION_API_URL=http://127.0.0.1:8000
   VITE_API_BASE_URL=http://127.0.0.1:8000
   ```

4. Create `backend/.env` from `backend/.env.example` and provide the provider keys:

   ```env
   DEEPGRAM_API_KEY=...
   GEMINI_API_KEY=...
   DATABASE_URL=...
   REDIS_URL=redis://127.0.0.1:6379/0
   VIVEKA_REDIS_MAX_CONNECTIONS=6
   VIVEKA_AUTH_SESSION_HOURS=24
   VIVEKA_PASSWORD_RESET_TOKEN_MINUTES=30
   VIVEKA_AUTH_EXPOSE_RESET_TOKEN=true
   VIVEKA_ADMIN_EMAILS=admin@example.com
   ```

5. Start the backend API:

   ```bash
   npm run backend:dev
   ```

6. Start the Redis-backed worker when background mode is enabled:

   ```bash
   npm run backend:worker
   ```

   The default worker script uses a lightweight Redis queue consumer with bounded Redis connection pools to stay within small hosted plan limits.

7. Start the frontend development server:

   ```bash
   npm run dev
   ```

8. Build for production validation when needed:

   ```bash
   npm run build
   ```

## Processing Flow

1. User uploads or records audio in the frontend.
2. The frontend streams the file to the FastAPI backend and listens for live progress events.
3. Larger files can be handed off to a Redis-backed worker instead of running in the request process.
4. FFmpeg normalizes the audio and splits it into 10-minute chunks with 60-second overlap when the file is too long for the direct path.
5. Deepgram transcribes chunks in a size-aware worker pool.
6. The merge engine removes overlap duplication and preserves speaker chronology.
7. The UI receives a transcript-ready result immediately after merge.
8. Gemini generates structured AWESOME artifacts automatically only for audio at or below `VIVEKA_GEMINI_AUTO_MAX_SECONDS`.
9. Longer audio completes with the transcript-first result to prioritize speed.

## Repository Notes

- local environment files are intentionally excluded from version control
- generated build output is excluded from version control
- temporary test audio artifacts are excluded from version control

## Included Documentation

- `VIVEKA_AI_SYSTEM_IMPLEMENTATION_REPORT.md` — formal implementation and validation report
- `VIVEKA_AI_vs_ECHO_COMPARATIVE_ANALYSIS.md` — earlier comparative analysis and architecture discussion
