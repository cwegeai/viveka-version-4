import React, { useEffect, useRef, useState } from 'react';

const API_BASE_URL =
  (import.meta as any).env?.VITE_API_BASE_URL || 'http://127.0.0.1:8000';

const ALLOWED_EXTENSIONS = ['csv', 'xlsx', 'xlsm', 'docx'];

const FORMATS = [
  { title: 'Word', ext: '.docx', icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z' },
  { title: 'Excel', ext: '.xlsx / .xlsm', icon: 'M3 10h18M3 14h18M10 3v18M5 3h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2z' },
  { title: 'CSV', ext: '.csv', icon: 'M4 6h16M4 10h16M4 14h16M4 18h16' },
];

const STEPS = [
  { n: '1', title: 'Extract', text: 'Read interview segments' },
  { n: '2', title: 'Batch', text: '~5,000 characters' },
  { n: '3', title: 'Parallel', text: '4 Gemini calls' },
  { n: '4', title: 'Map', text: 'Match by MU_ID' },
];

type BatchStatus = 'pending' | 'running' | 'done' | 'failed';

interface BatchInfo {
  batch: number;
  segments: number;
  chars: number;
  status: BatchStatus;
}

interface ProgressState {
  total: number;
  pending: number;
  running: number;
  completed: number;
  failed: number;
  maxParallel: number;
  segments: number;
  stage: 'coding' | 'finalizing';
  batches: BatchInfo[];
}

const BATCH_TILE_STYLES: Record<BatchStatus, string> = {
  pending: 'bg-slate-100 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-400 dark:text-slate-500',
  running: 'bg-violet-100 dark:bg-violet-900/40 border-violet-400 text-violet-700 dark:text-violet-300 animate-pulse',
  done: 'bg-emerald-500 border-emerald-500 text-white',
  failed: 'bg-rose-500 border-rose-500 text-white',
};

const BATCH_STATUS_LABEL: Record<BatchStatus, string> = {
  pending: 'Pending',
  running: 'In progress',
  done: 'Completed',
  failed: 'Failed',
};

const fmtTime = (s: number) =>
  `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

export const InterviewCoding: React.FC = () => {
  const inputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState('');
  const [downloadUrl, setDownloadUrl] = useState('');
  const [downloadName, setDownloadName] = useState('');
  const [docxUrl, setDocxUrl] = useState('');
  const [docxName, setDocxName] = useState('');
  const [progress, setProgress] = useState<ProgressState | null>(null);

  // Elapsed timer while processing
  useEffect(() => {
    if (!processing) return;
    setElapsed(0);
    const id = window.setInterval(() => setElapsed(s => s + 1), 1000);
    return () => window.clearInterval(id);
  }, [processing]);

  // Release blob URL + abort in-flight request on unmount / replacement
  useEffect(() => {
    return () => {
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
  }, [downloadUrl]);

  useEffect(() => {
    return () => {
      if (docxUrl) URL.revokeObjectURL(docxUrl);
    };
  }, [docxUrl]);

  useEffect(() => {
    return () => abortRef.current?.abort();
  }, []);

  const clearResult = () => {
    setError('');
    setDownloadUrl('');
    setDocxUrl('');
  };

  const selectFile = (selected?: File | null) => {
    clearResult();
    if (!selected) return;

    const ext = selected.name.split('.').pop()?.toLowerCase() || '';
    if (!ALLOWED_EXTENSIONS.includes(ext)) {
      setFile(null);
      setError('Unsupported format. Upload CSV, Excel (.xlsx/.xlsm), or Word (.docx).');
      return;
    }
    setFile(selected);
  };

  const removeFile = () => {
    setFile(null);
    clearResult();
    if (inputRef.current) inputRef.current.value = '';
  };

  const cancelProcessing = () => {
    abortRef.current?.abort();
    abortRef.current = null;
    setProcessing(false);
    setProgress(null);
  };

  const startCoding = async () => {
    if (!file) {
      setError('Please select a file first.');
      return;
    }

    clearResult();
    setProcessing(true);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch(`${API_BASE_URL}/api/code/stream`, {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `Server error: ${response.status}`;
        try {
          const data = await response.json();
          if (data?.detail) message = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail);
        } catch {
          /* response was not JSON */
        }
        throw new Error(message);
      }

      // The server streams one JSON object per line: start -> batch updates -> finalizing -> done.
      const handleEvent = (event: any): boolean => {
        if (controller.signal.aborted) return false;

        if (event.type === 'start') {
          setProgress({
            total: event.total_batches,
            pending: event.total_batches,
            running: 0,
            completed: 0,
            failed: 0,
            maxParallel: event.max_parallel,
            segments: event.total_segments,
            stage: 'coding',
            batches: (event.batches || []).map((b: any) => ({ ...b, status: 'pending' as BatchStatus })),
          });
        } else if (event.type === 'batch') {
          setProgress(prev =>
            prev && {
              ...prev,
              pending: event.pending,
              running: event.running,
              completed: event.completed,
              failed: event.failed,
              batches: prev.batches.map(b => (b.batch === event.batch ? { ...b, status: event.status as BatchStatus } : b)),
            },
          );
        } else if (event.type === 'finalizing') {
          setProgress(prev => prev && { ...prev, stage: 'finalizing' });
        } else if (event.type === 'error') {
          throw new Error(event.detail || 'Processing failed.');
        } else if (event.type === 'done') {
          setDownloadUrl(URL.createObjectURL(base64ToBlob(event.excel, XLSX_MIME)));
          setDownloadName(buildDownloadName(file.name, 'xlsx'));
          setDocxUrl(URL.createObjectURL(base64ToBlob(event.word, DOCX_MIME)));
          setDocxName(buildDownloadName(file.name, 'docx'));
          return true;
        }
        return false;
      };

      const reader = response.body?.getReader();
      if (!reader) throw new Error('This browser cannot read the live progress stream.');

      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (line.trim() && handleEvent(JSON.parse(line))) finished = true;
        }
      }

      if (!finished && !controller.signal.aborted) {
        throw new Error('The connection closed before processing finished.');
      }
    } catch (err: any) {
      if (err?.name === 'AbortError') return;
      setError(err?.message || 'Processing failed.');
    } finally {
      if (abortRef.current === controller) {
        abortRef.current = null;
        setProcessing(false);
        setProgress(null);
      }
    }
  };

  return (
    <div className="w-full max-w-3xl mx-auto p-5 md:p-10 flex flex-col gap-8">
      {/* HEADER */}
      <div className="flex flex-col items-center text-center gap-4">
        <div className="flex items-center gap-3 px-6 py-2 bg-violet-50 dark:bg-violet-900/20 border border-violet-100 dark:border-violet-800 rounded-full">
          <span className="w-3 h-3 bg-violet-500 rounded-full shadow-[0_0_12px_rgba(124,58,237,0.6)]" />
          <span className="text-[10px] font-black text-violet-600 dark:text-violet-400 uppercase tracking-[0.3em]">
            PRISM AI Coding
          </span>
        </div>
        <h3 className="text-3xl md:text-4xl font-black text-[#1e293b] dark:text-white tracking-tight">
          Automated Interview Coding
        </h3>
        <p className="text-slate-500 dark:text-slate-400 font-semibold text-sm max-w-md leading-relaxed">
          Upload an interview document and classify its segments using the PRISM codebook.
        </p>
      </div>

      {/* DROPZONE */}
      <div
        onDragOver={e => { e.preventDefault(); if (!processing) setIsDragging(true); }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={e => {
          e.preventDefault();
          setIsDragging(false);
          if (!processing) selectFile(e.dataTransfer.files?.[0]);
        }}
        className={`rounded-[2rem] md:rounded-[2.5rem] p-1 transition-all
          ${isDragging ? 'ring-2 ring-violet-500 ring-offset-4 dark:ring-offset-slate-950' : 'shadow-2xl shadow-slate-200/50 dark:shadow-none'}
        `}
      >
        <div
          className={`rounded-[1.75rem] md:rounded-[2.25rem] border-2 border-dashed px-6 py-10 md:py-14 flex flex-col items-center text-center gap-5 transition-colors
            ${file
              ? 'border-violet-400 dark:border-violet-600 bg-violet-50/50 dark:bg-violet-900/10'
              : 'border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900'}
          `}
        >
          <div className="w-16 h-16 bg-[#0f172a] dark:bg-violet-600 rounded-2xl flex items-center justify-center text-white shadow-lg">
            <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>

          <div className="space-y-1">
            <h4 className="text-xl md:text-2xl font-black text-[#1e293b] dark:text-white tracking-tight">
              Upload Interview File
            </h4>
            <p className="text-sm text-slate-500 dark:text-slate-400 font-semibold">
              Drag and drop your file here, or choose one below.
            </p>
          </div>

          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={processing}
            className="bg-[#1e293b] dark:bg-violet-600 text-white px-10 py-4 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] shadow-2xl hover:bg-violet-600 dark:hover:bg-violet-500 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {file ? 'Change File' : 'Choose File'}
          </button>

          <input
            ref={inputRef}
            type="file"
            accept=".csv,.xlsx,.xlsm,.docx"
            onChange={e => selectFile(e.target.files?.[0])}
            className="hidden"
          />

          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500">
            CSV · Excel (.xlsx/.xlsm) · Word (.docx)
          </p>
        </div>
      </div>

      {/* SELECTED FILE */}
      {file && (
        <div className="flex items-center justify-between gap-4 p-4 md:p-5 bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-2xl shadow-sm">
          <div className="flex items-center gap-4 min-w-0">
            <div className="w-10 h-10 bg-violet-50 dark:bg-violet-900/30 rounded-xl flex items-center justify-center text-violet-600 dark:text-violet-400 shrink-0">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            <div className="min-w-0">
              <p className="font-bold text-slate-900 dark:text-white text-sm truncate" title={file.name}>{file.name}</p>
              <p className="text-xs text-slate-400 dark:text-slate-500 font-mono">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
            </div>
          </div>
          <button
            type="button"
            onClick={removeFile}
            disabled={processing}
            className="px-5 py-2.5 rounded-xl border border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400 hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors font-bold text-sm shrink-0 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            Remove
          </button>
        </div>
      )}

      {/* PIPELINE */}
      {/*
      <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-100 dark:border-slate-700 rounded-[1.5rem] md:rounded-[2rem] p-5 md:p-6">
        <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400 dark:text-slate-500 mb-4">
          AI Processing Pipeline
        </p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
          {STEPS.map((s, i) => (
            <div
              key={s.n}
              className="bg-white dark:bg-slate-900 border border-slate-100 dark:border-slate-700 rounded-2xl p-4 flex flex-col gap-1.5"
            >
              <div
                className={`w-7 h-7 rounded-lg bg-violet-600 text-white text-xs font-black flex items-center justify-center shadow-md shadow-violet-500/30 ${processing ? 'animate-pulse' : ''}`}
                style={processing ? { animationDelay: `${i * 250}ms` } : undefined}
              >
                {s.n}
              </div>
              <strong className="text-sm font-black text-slate-900 dark:text-white">{s.title}</strong>
              <span className="text-[11px] text-slate-500 dark:text-slate-400 leading-snug">{s.text}</span>
            </div>
          ))}
        </div>
      </div>
      */}

      {/* ACTION */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <p className="text-xs text-slate-500 dark:text-slate-400 font-semibold text-center md:text-left">
          Original interview columns are preserved in the output.
        </p>
        <div className="flex items-center justify-center gap-3">
          {processing && (
            <button
              type="button"
              onClick={cancelProcessing}
              className="px-6 py-4 rounded-2xl border border-rose-300 dark:border-rose-800 text-rose-600 dark:text-rose-400 font-bold text-sm hover:bg-rose-50 dark:hover:bg-rose-900/20 transition-colors"
            >
              Cancel
            </button>
          )}
          <button
            type="button"
            onClick={startCoding}
            disabled={!file || processing}
            className={`px-10 py-4 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] text-white transition-all
              ${!file || processing
                ? 'bg-slate-200 dark:bg-slate-800 text-slate-400 dark:text-slate-600 cursor-not-allowed'
                : 'bg-violet-600 hover:bg-violet-700 hover:scale-105 active:scale-95 shadow-2xl shadow-violet-500/30'}
            `}
          >
            {processing ? 'Processing...' : 'Start AI Coding'}
          </button>
        </div>
      </div>

      {/* STATUS - live batch progress */}
      {processing && (
        <div className="p-5 md:p-6 bg-white dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-2xl shadow-sm flex flex-col gap-5">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm md:text-base font-black uppercase tracking-tight text-[#1e293b] dark:text-white">
              {!progress
                ? 'Reading file & creating batches'
                : progress.stage === 'finalizing'
                  ? 'Building Excel & Word files'
                  : 'Coding with Gemini'}
            </p>
            <div className="flex items-center gap-2 shrink-0">
              <span className="w-1.5 h-1.5 bg-violet-500 rounded-full animate-pulse" />
              <span className="text-slate-500 dark:text-slate-400 text-sm font-bold font-mono">{fmtTime(elapsed)}</span>
            </div>
          </div>

          {progress ? (
            <>
              {/* Overall progress */}
              <div>
                <div className="flex items-center justify-between text-xs font-bold text-slate-500 dark:text-slate-400 mb-2">
                  <span>
                    {progress.completed} of {progress.total} batches completed
                  </span>
                  <span className="font-mono">
                    {progress.total ? Math.round((progress.completed / progress.total) * 100) : 0}%
                  </span>
                </div>
                <div className="w-full h-3 bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden border border-slate-200 dark:border-slate-700 shadow-inner">
                  <div
                    className="h-full bg-violet-600 rounded-full transition-all duration-500 shadow-[0_0_15px_rgba(124,58,237,0.4)]"
                    style={{ width: `${progress.total ? (progress.completed / progress.total) * 100 : 0}%` }}
                  />
                </div>
              </div>

              {/* Pending / In progress / Completed */}
              <div className="grid grid-cols-3 gap-3">
                <ProgressCounter label="Pending" value={progress.pending} tone="slate" />
                <ProgressCounter label="In progress" value={progress.running} tone="violet" pulse={progress.running > 0} />
                <ProgressCounter label="Completed" value={progress.completed} tone="emerald" />
              </div>

              {/* One tile per batch */}
              <div>
                <div className="flex flex-wrap gap-2 max-h-44 overflow-y-auto p-1">
                  {progress.batches.map(b => (
                    <div
                      key={b.batch}
                      title={`Batch ${b.batch} - ${BATCH_STATUS_LABEL[b.status]}: ${b.segments} segments, ${b.chars.toLocaleString()} characters`}
                      className={`w-9 h-9 rounded-lg border text-[11px] font-black flex items-center justify-center transition-colors duration-300 ${BATCH_TILE_STYLES[b.status]}`}
                    >
                      {b.batch}
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[10px] font-bold uppercase tracking-widest text-slate-400 dark:text-slate-500">
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-slate-300 dark:bg-slate-600" />Pending</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-violet-500" />In progress</span>
                  <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded bg-emerald-500" />Completed</span>
                </div>
              </div>

              <p className="text-xs text-slate-400 dark:text-slate-500 font-semibold text-center">
                {progress.segments} segments in {progress.total} batches &middot; up to {progress.maxParallel} Gemini calls at a time
              </p>
            </>
          ) : (
            <div className="w-full h-3 bg-slate-100 dark:bg-slate-900 rounded-full overflow-hidden border border-slate-200 dark:border-slate-700 shadow-inner">
              <div className="h-full w-2/5 bg-violet-600 rounded-full animate-pulse shadow-[0_0_15px_rgba(124,58,237,0.4)]" />
            </div>
          )}
        </div>
      )}

      {/* ERROR */}
      {error && (
        <div className="p-5 bg-rose-50 dark:bg-rose-900/20 border border-rose-200 dark:border-rose-800 rounded-2xl" role="alert">
          <p className="text-[10px] font-black uppercase tracking-[0.2em] text-rose-600 dark:text-rose-400 mb-1">
            Processing failed
          </p>
          <p className="text-sm text-rose-700 dark:text-rose-300 font-semibold break-words">{error}</p>
        </div>
      )}

      {/* SUCCESS */}
      {downloadUrl && (
        <div className="p-6 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-2xl flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <p className="text-[10px] font-black uppercase tracking-[0.2em] text-emerald-700 dark:text-emerald-400 mb-1">
              AI coding completed
            </p>
            <p className="text-sm text-emerald-800 dark:text-emerald-300 font-semibold">Your coded files are ready.</p>
          </div>
          <div className="flex flex-col sm:flex-row gap-3">
            <a
              href={downloadUrl}
              download={downloadName}
              className="inline-flex items-center justify-center gap-2 bg-emerald-600 hover:bg-emerald-700 text-white px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] shadow-xl shadow-emerald-500/20 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download Excel
            </a>
            <a
              href={docxUrl}
              download={docxName}
              className="inline-flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-8 py-4 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] shadow-xl shadow-blue-500/20 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              Download Word
            </a>
          </div>
        </div>
      )}
    </div>
  );
};


// <uploaded file name>_PRISM_coded_<DD-MM-YYYY>_<hh-mm-ss>_<AM/PM>.<xlsx|docx>
function buildDownloadName(uploadedName: string, extension: 'xlsx' | 'docx'): string {
  const stem =
    uploadedName
      .replace(/\.[^.]+$/, '')
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .trim() || 'interview';
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  const hour12 = d.getHours() % 12 || 12;
  const amPm = d.getHours() < 12 ? 'AM' : 'PM';
  const stamp = `${p(d.getDate())}-${p(d.getMonth() + 1)}-${d.getFullYear()}_${p(hour12)}-${p(d.getMinutes())}-${p(d.getSeconds())}_${amPm}`;
  return `${stem}_PRISM_coded_${stamp}.${extension}`;
}


const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

// The server sends both files as base64 text inside one JSON response.
function base64ToBlob(base64: string, mimeType: string): Blob {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: mimeType });
}

function ProgressCounter({
  label,
  value,
  tone,
  pulse = false,
}: {
  label: string;
  value: number;
  tone: 'slate' | 'violet' | 'emerald';
  pulse?: boolean;
}) {
  const tones = {
    slate: 'bg-slate-50 dark:bg-slate-900 border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-300',
    violet: 'bg-violet-50 dark:bg-violet-900/20 border-violet-200 dark:border-violet-800 text-violet-700 dark:text-violet-300',
    emerald: 'bg-emerald-50 dark:bg-emerald-900/20 border-emerald-200 dark:border-emerald-800 text-emerald-700 dark:text-emerald-300',
  };
  return (
    <div className={`rounded-2xl border p-4 text-center transition-colors ${tones[tone]} ${pulse ? 'animate-pulse' : ''}`}>
      <p className="text-3xl font-black tabular-nums leading-none">{value}</p>
      <p className="mt-2 text-[10px] font-black uppercase tracking-[0.2em] opacity-80">{label}</p>
    </div>
  );
}