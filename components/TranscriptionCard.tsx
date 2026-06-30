import React, { useState } from 'react';
import { TranscriptionResult } from '../types';
import { jsPDF } from 'jspdf';
import { uploadToMinio } from '../services/minio.service';
import { getAccessToken, getStoredUser } from '../services/authStorage';
import { TRANSCRIPTION_API_URL } from '../services/config';

interface Props {
  result: TranscriptionResult;
  audioUrl?: string;
  originalFileName?: string;
  originalFile?: File;
  onRestart: () => void;
  processingTimeTaken?: number | null;
}

const s = (val: any): string => val?.toString() || "";

const TranscriptView: React.FC<{ result: TranscriptionResult }> = ({ result }) => (
  <div className="max-w-4xl mx-auto space-y-12 bg-white dark:bg-slate-950">
    {result.summary && (
      <div className="space-y-4">
        <h3 className="text-3xl font-black text-slate-900 border-b-8 border-slate-900 pb-3 uppercase tracking-tighter">Summary</h3>
        <div className="text-xl leading-relaxed text-slate-800 font-serif text-justify bg-slate-50 p-6 rounded-2xl border border-slate-100">
          {result.summary}
        </div>
        {(result.keyPoints?.length ?? 0) > 0 && (
          <ul className="space-y-2 pt-2">
            {result.keyPoints.map((pt, i) => (
              <li key={i} className="flex items-start gap-3 text-sm text-slate-700 font-medium">
                <span className="w-5 h-5 bg-violet-600 text-white text-[9px] font-black rounded-full flex items-center justify-center shrink-0 mt-0.5">{i+1}</span>
                {pt}
              </li>
            ))}
          </ul>
        )}
      </div>
    )}

    <div className="pt-10 space-y-12">
      <div className="flex items-end justify-between border-b-8 border-slate-900 pb-3">
        <h3 className="text-3xl font-black text-slate-900 uppercase tracking-tighter">Verbatim Record</h3>
        <span className="text-[10px] font-black text-slate-400 uppercase tracking-[0.5em] pb-1">Zero-Loss Sync v8.0</span>
      </div>
      <div className="space-y-16">
        {result.turns.map((turn, idx) => (
          <div key={idx} className="space-y-6 group relative">
            <div className="flex items-center gap-4 bg-slate-50 p-4 rounded-2xl border border-slate-100 transition-all group-hover:bg-slate-100/50">
              <div className="flex items-center gap-2">
                <span className="font-black text-slate-900 uppercase text-base tracking-tight">{s(turn.speaker)}</span>
                <span className="text-slate-300">•</span>
                <span className="text-xs font-black uppercase tracking-[0.2em] text-violet-600">MU {s(turn.mu_id)}</span>
              </div>
              <div className="ml-auto flex items-center gap-2">
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Start</span>
                <span className="text-sm bg-slate-900 text-white px-4 py-1.5 rounded-xl font-mono font-bold shadow-lg shadow-slate-200">
                  {turn.timestamp}
                </span>
              </div>
            </div>

            <div className="flex flex-wrap gap-3 pl-8 -mt-2 text-[10px] font-black uppercase tracking-[0.18em] text-slate-500">
              <span className="bg-slate-100 px-3 py-2 rounded-xl">Start: {turn.timestamp}</span>
              <span className="bg-slate-100 px-3 py-2 rounded-xl">End: {formatSecondsForPdf(turn.end_time_seconds)}</span>
              <span className="bg-slate-100 px-3 py-2 rounded-xl">Duration: {Math.max(turn.duration_seconds ?? 0, 0).toFixed(1)}s</span>
              {typeof turn.confidence === 'number' && (
                <span className="bg-slate-100 px-3 py-2 rounded-xl">Accuracy: {(turn.confidence * 100).toFixed(1)}%</span>
              )}
            </div>

            <div className="pl-8 space-y-6 border-l-8 border-slate-50 group-hover:border-violet-200 transition-colors">
              <div className="space-y-3">
                 <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Original</p>
                 <div className="text-4xl font-bold text-slate-900 leading-snug indian-script">{s(turn.original)}</div>
              </div>
              
              {turn.transliterated && (
                <div className="space-y-2">
                  <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Transliteration</p>
                  <div className="text-base font-bold text-slate-400 italic tracking-tight">{s(turn.transliterated)}</div>
                </div>
              )}

              <div className="space-y-3 pt-4 border-t border-slate-50">
                 <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">English Translation</p>
                 <div className="text-2xl text-slate-700 font-serif leading-relaxed italic">"{s(turn.translated)}"</div>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

const downloadJson = (data: unknown, filename: string) => {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
};

const downloadCsv = (turns: TranscriptionResult['turns'], filename: string) => {
  const esc = (v: unknown): string => {
    const s = String(v ?? '');
    // Always quote — handles commas, newlines, and quotes inside non-Latin scripts
    return '"' + s.replace(/"/g, '""').replace(/\r?\n/g, ' ') + '"';
  };
  const headers = ['#', 'Speaker', 'MU_ID', 'Timestamp', 'Start(s)', 'End(s)', 'Duration(s)', 'Original Script', 'Transliteration', 'English Translation', 'Language', 'Confidence(%)'];
  const rows = turns.map((t, i) => [
    i + 1,
    esc(t.speaker),
    esc(t.mu_id),
    esc(t.timestamp),
    t.start_time_seconds?.toFixed(2) ?? '',
    t.end_time_seconds?.toFixed(2) ?? '',
    t.duration_seconds != null ? Math.max(0, t.duration_seconds).toFixed(1) : '',
    esc(t.original),
    esc(t.transliterated),
    esc(t.translated),
    esc(t.language ?? ''),
    t.confidence != null ? (t.confidence * 100).toFixed(1) : '',
  ].join(','));
  const csv = [headers.map(h => esc(h)).join(','), ...rows].join('\r\n');
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
};

const DownloadBtn: React.FC<{ onClick: () => void; label: string }> = ({ onClick, label }) => (
  <button
    onClick={onClick}
    className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 text-white text-[9px] font-black uppercase tracking-widest hover:bg-violet-600 transition-all shadow"
  >
    <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
    </svg>
    {label}
  </button>
);

const ArtifactHeader: React.FC<{ title: string; onDownload: () => void }> = ({ title, onDownload }) => (
  <div className="flex items-end justify-between border-b-8 border-slate-900 pb-3">
    <h3 className="text-3xl font-black text-slate-900 uppercase tracking-tighter">{title}</h3>
    <DownloadBtn onClick={onDownload} label="Download JSON" />
  </div>
);

const EmptyState: React.FC<{ label: string }> = ({ label }) => (
  <div className="py-8 text-center text-slate-400 text-sm italic bg-slate-50 rounded-2xl border border-dashed border-slate-200">
    {label}
  </div>
);

const ArtifactsView: React.FC<{ result: TranscriptionResult }> = ({ result }) => (
  <div className="max-w-4xl mx-auto flex flex-col items-center justify-center py-20 px-8">
    <div className="w-20 h-20 bg-violet-100 rounded-3xl flex items-center justify-center mb-8 shadow-inner">
      <svg className="w-10 h-10 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
      </svg>
    </div>
    <h3 className="text-3xl font-black text-slate-900 uppercase tracking-tighter mb-3">AWESOME Artifacts</h3>
    <div className="flex items-center gap-2 mb-6">
      <span className="px-4 py-1.5 bg-amber-100 text-amber-700 text-[10px] font-black uppercase tracking-widest rounded-full border border-amber-200">
        Coming Soon
      </span>
    </div>
    <p className="text-slate-500 text-center max-w-md leading-relaxed text-sm">
      Evidence Matrix, Context Matrix, Mechanism Chains, Systems Link Map, Vulnerability Hotspots, and SMART Strategies will be available in a future update.
    </p>
    <div className="mt-10 grid grid-cols-2 md:grid-cols-3 gap-3 w-full max-w-lg">
      {['Evidence Matrix', 'Context Matrix', 'Mechanism Chains', 'Link Map', 'Hotspots', 'Strategies'].map((label) => (
        <div key={label} className="bg-slate-50 border border-slate-100 rounded-2xl p-4 text-center opacity-50">
          <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{label}</p>
        </div>
      ))}
    </div>
  </div>
);

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return window.btoa(binary);
}

function detectFontFamily(text: string): string {
  if (!text) return 'Latin';
  if (/[\u0D00-\u0D7F]/.test(text)) return 'Malayalam';
  if (/[\u0900-\u097F]/.test(text)) return 'Devanagari';
  if (/[\u0B00-\u0B7F]/.test(text)) return 'Oriya';
  if (/[\u0B80-\u0BFF]/.test(text)) return 'Tamil';
  if (/[\u0C00-\u0C7F]/.test(text)) return 'Telugu';
  return 'Latin';
}

const FONT_LIST = [
  { name: "Latin", style: "normal", file: "NotoSans-Regular.ttf" },
  { name: "Malayalam", style: "normal", file: "NotoSansMalayalam-Regular.ttf" },
  { name: "Devanagari", style: "normal", file: "NotoSans-Regular.ttf" },
  { name: "Oriya", style: "normal", file: "NotoSansOriya-Regular.ttf" },
  { name: "Tamil", style: "normal", file: "NotoSansTamil-Regular.ttf" },
  { name: "Telugu", style: "normal", file: "NotoSansTelugu-Regular.ttf" },
];

const PDF_FONT_STYLES: Array<'normal' | 'italic' | 'bold' | 'bolditalic'> = [
  'normal',
  'italic',
  'bold',
  'bolditalic',
];

const resolvePdfFontStyle = (fontName: string, preferredStyle: string): 'normal' | 'italic' | 'bold' | 'bolditalic' => {
  if (fontName === 'Latin') {
    if (preferredStyle === 'italic' || preferredStyle === 'bold' || preferredStyle === 'bolditalic') {
      return preferredStyle;
    }
    return 'normal';
  }

  return 'normal';
};


const formatSecondsForPdf = (seconds: number | undefined) => {
  const safe = Math.max(0, seconds || 0);
  const minutes = Math.floor(safe / 60);
  const remainingSeconds = Math.floor(safe % 60);
  return `${minutes.toString().padStart(2, '0')}:${remainingSeconds.toString().padStart(2, '0')}`;
};

const normalizeSpeakerLabel = (speaker: string) => {
  const trimmed = (speaker || '').trim();
  if (!trimmed) {
    return 'Speaker';
  }
  const speakerMatch = trimmed.match(/^speaker\s*(\d+)$/i);
  if (speakerMatch) {
    return `Speaker ${speakerMatch[1]}`;
  }
  return trimmed;
};

export const TranscriptionCard: React.FC<Props> = ({ result, audioUrl, originalFileName, onRestart, processingTimeTaken }) => {
  const sessionId = result.session_id;
  const [activeTab, setActiveTab] = useState<'transcript' | 'artifacts'>('transcript');
  const [isExporting, setIsExporting] = useState(false);
  const [isSendingEmail, setIsSendingEmail] = useState(false);
  const [emailStatus, setEmailStatus] = useState<string | null>(null);

  const sendByEmail = async () => {
    const user = getStoredUser();
    const recipientEmail = user?.email;
    if (!recipientEmail) {
      alert('No email address found for your account.');
      return;
    }
    setIsSendingEmail(true);
    setEmailStatus(null);
    try {
      const folderPath = '/fonts/';
      const fileCache = new Map<string, string>();
      const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });
      const neededFonts = new Set<string>(['Latin']);
      result.turns.forEach((turn) => {
        neededFonts.add(detectFontFamily(turn.original));
        neededFonts.add(detectFontFamily(turn.translated));
      });
      await Promise.all(
        FONT_LIST.filter((f) => neededFonts.has(f.name)).map(async (font) => {
          let base64: string;
          if (fileCache.has(font.file)) { base64 = fileCache.get(font.file)!; }
          else {
            const res = await fetch(`${folderPath}${font.file}`);
            if (!res.ok) return;
            base64 = arrayBufferToBase64(await res.arrayBuffer());
            fileCache.set(font.file, base64);
          }
          pdf.addFileToVFS(font.file, base64);
          PDF_FONT_STYLES.forEach((style) => pdf.addFont(font.file, font.name, style));
        })
      );
      const summaryText = (result.summary || '').trim() ||
        (result.turns || []).slice(0,3).map((t: TranscriptionResult['turns'][number]) => (t.translated || t.original || '').trim()).filter(Boolean).join(' ') ||
        'Transcript available.';
      const margin = 18, pageWidth = pdf.internal.pageSize.getWidth();
      const contentWidth = pageWidth - margin * 2;
      const pageHeight = pdf.internal.pageSize.getHeight();
      let y = 18;
      const checkPageBreak = (n: number) => { if (y + n > pageHeight - 20) { pdf.addPage(); y = 20; } };
      const addText = (text: string, fs: number, style = 'normal', color: [number,number,number] = [0,0,0], indent = 0, font = 'Latin') => {
        pdf.setFontSize(fs); pdf.setFont(font, resolvePdfFontStyle(font, style)); pdf.setTextColor(...color);
        const lines: string[] = pdf.splitTextToSize(text || '', contentWidth - indent);
        const lh = fs * 0.5;
        lines.forEach(line => { checkPageBreak(lh); pdf.text(line, margin + indent, y); y += lh; });
        y += 2;
      };
      pdf.setFont('Latin','bold'); pdf.setFontSize(22); pdf.setTextColor(15,23,42);
      pdf.text('Viveka AI', margin, y);
      y += 8;
      pdf.setFont('Latin','normal'); pdf.setFontSize(9); pdf.setTextColor(100,116,139);
      pdf.text('QUALITATIVE VERBATIM SPECIALIST', margin, y);
      y += 5;
      pdf.setFont('Latin','bold'); pdf.setFontSize(12); pdf.setTextColor(15,23,42);
      pdf.text('Research Dossier', margin, y);
      pdf.setTextColor(124,58,237);
      pdf.text(' AWESOME Framework', margin + pdf.getTextWidth('Research Dossier'), y);
      y += 10;
      pdf.setFillColor(15,23,42);
      const bl = 'VIVEKA AI  ·  HIGH-FIDELITY QUALITATIVE RESEARCH';
      pdf.setFontSize(6.5);
      const blW = pdf.getTextWidth(bl) + 8;
      pdf.roundedRect(margin, y, blW, 5.5, 1.5, 1.5, 'F');
      pdf.setTextColor(255,255,255); pdf.setFont('Latin','bold');
      pdf.text(bl, margin+4, y+3.8);
      y += 11;
      pdf.setDrawColor(226,232,240); pdf.setLineWidth(0.3);
      pdf.line(margin, y, margin+contentWidth, y); y += 6;
      // Metadata card
      pdf.setFillColor(248,250,252); pdf.setDrawColor(226,232,240); pdf.setLineWidth(0.3);
      pdf.roundedRect(margin, y, contentWidth, 20, 3, 3, 'FD');
      pdf.setFont('Latin','bold'); pdf.setFontSize(7); pdf.setTextColor(148,163,184);
      pdf.text('DOCUMENT', margin+5, y+8);
      pdf.setFont('Latin','normal'); pdf.setFontSize(8.5); pdf.setTextColor(15,23,42);
      pdf.text(originalFileName || 'Session_Archive', margin+30, y+8);
      pdf.setFont('Latin','bold'); pdf.setFontSize(7); pdf.setTextColor(148,163,184);
      pdf.text('GENERATED', margin+5, y+17);
      pdf.setFont('Latin','normal'); pdf.setFontSize(8.5); pdf.setTextColor(15,23,42);
      pdf.text(new Date().toLocaleString('en-GB', {day:'numeric',month:'long',year:'numeric',hour:'2-digit',minute:'2-digit'}), margin+30, y+17);
      y += 26;
      addText('INTERVIEW SUMMARY', 13, 'bold', [15,23,42]);
      addText(summaryText, 10, 'italic', [51,65,85], 8, detectFontFamily(summaryText));
      y += 6;
      addText('FULL VERBATIM RECORD', 12, 'bold', [15,23,42]);
      result.turns?.forEach((turn) => {
        checkPageBreak(30);
        pdf.setFillColor(248,250,252); pdf.rect(margin, y, contentWidth, 9, 'F');
        pdf.setTextColor(124,58,237); pdf.setFontSize(8); pdf.setFont('Latin','bold');
        pdf.text(normalizeSpeakerLabel(turn.speaker).toUpperCase(), margin+4, y+5.8);
        pdf.setTextColor(100,116,139); pdf.setFont('Latin','normal'); pdf.setFontSize(7);
        pdf.text(`Start ${turn.timestamp}`, pageWidth - margin - 24, y+5.8);
        y += 13;
        addText(turn.original, 12, 'bold', [15,23,42], 4, detectFontFamily(turn.original));
        if (turn.transliterated) addText(turn.transliterated, 9, 'italic', [120,130,145], 4, detectFontFamily(turn.transliterated));
        addText(turn.translated, 10, 'italic', [51,65,85], 4, detectFontFamily(turn.translated));
        y += 4;
      });
      const safeBase2 = (originalFileName || 'session').replace(/\.[^/.]+$/, '').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 40);
      const fileName = `Viveka_${safeBase2}_${Date.now()}.pdf`;
      const blob = pdf.output('blob');
      // const formData = new FormData();
      // formData.append('recipient_email', recipientEmail);
      // formData.append('filename', fileName);
      // formData.append('original_filename', originalFileName || '');
      // formData.append('pdf', new File([blob], fileName, { type: 'application/pdf' }));
      // formData.append("session_id", sessionId || "");
      // const apiBase = TRANSCRIPTION_API_URL?.replace('/api/transcribe', '') || '';
      // const res = await fetch(`${apiBase}/api/send-pdf`, {
      //   method: 'POST',
      //   headers: { Authorization: `Bearer ${getAccessToken() || ''}` },
      //   body: formData,
      // });
      // if (!res.ok) {
      //   const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
      //   throw new Error(err.detail || `HTTP ${res.status}`);
      // }
      // setEmailStatus(`Dossier sent to ${recipientEmail}`);
    } catch (err: any) {
      setEmailStatus(`Failed: ${err.message}`);
    } finally {
      setIsSendingEmail(false);
    }
  };


  const generateWord = async () => {
    try {
      const { Document, Packer, Paragraph, HeadingLevel, TextRun } = await import('docx');
      const { saveAs } = await import('file-saver');
      const doc = new Document({
        sections: [{
          children: [
            new Paragraph({ text: "VIVEKA AI RESEARCH DOSSIER", heading: HeadingLevel.TITLE }),
            new Paragraph({ text: "" }),
            ...(result.summary ? [
              new Paragraph({ text: "INTERVIEW SUMMARY", heading: HeadingLevel.HEADING_1 }),
              new Paragraph({ children: [new TextRun(result.summary)] }),
              new Paragraph({ text: "" }),
            ] : []),
            new Paragraph({ text: "FULL VERBATIM RECORD", heading: HeadingLevel.HEADING_1 }),
            ...result.turns.flatMap((turn) => [
              new Paragraph({ text: normalizeSpeakerLabel(turn.speaker), heading: HeadingLevel.HEADING_2 }),
              new Paragraph({ children: [new TextRun({ text: "Original: ", bold: true }), new TextRun(turn.original || "")] }),
              new Paragraph({ children: [new TextRun({ text: "Transliteration: ", bold: true }), new TextRun(turn.transliterated || "")] }),
              new Paragraph({ children: [new TextRun({ text: "English Translation: ", bold: true }), new TextRun(turn.translated || "")] }),
              new Paragraph({ text: "" }),
            ]),
          ],
        }],
      });
      const blob = await Packer.toBlob(doc);
      saveAs(blob, `Viveka_${(originalFileName || 'Transcript').replace(/\.[^/.]+$/, '')}.docx`);
      const apiBase = TRANSCRIPTION_API_URL?.replace("/api/transcribe", "") || "";

      if (sessionId) {
        await fetch(
          `${apiBase}/api/admin/activity/${sessionId}/flag?flag=doc_downloaded`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${getAccessToken() || ""}`,
            },
          }
        );
      }
    } catch (err) {
      console.error(err);
      alert('Word export failed. Make sure docx and file-saver are installed:\nnpm install docx file-saver');
    }
  };

  const generatePDF = async () => {
    setIsExporting(true);

    const folderPath = "/fonts/";
    const fileCache = new Map<string, string>();

    try {
      const pdf = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });

      // ── Font loading ───────────────────────────────────────────────────────
      const neededFonts = new Set<string>(['Latin']);
      result.turns.forEach((turn) => {
        neededFonts.add(detectFontFamily(turn.original));
        neededFonts.add(detectFontFamily(turn.transliterated));
        neededFonts.add(detectFontFamily(turn.translated));
      });
      await Promise.all(
        FONT_LIST.filter((font) => neededFonts.has(font.name)).map(async (font) => {
          let fontBase64: string;
          if (fileCache.has(font.file)) {
            fontBase64 = fileCache.get(font.file)!;
          } else {
            const response = await fetch(`${folderPath}${font.file}`);
            if (!response.ok) throw new Error(`Failed to fetch ${font.file}`);
            fontBase64 = arrayBufferToBase64(await response.arrayBuffer());
            fileCache.set(font.file, fontBase64);
          }
          pdf.addFileToVFS(font.file, fontBase64);
          PDF_FONT_STYLES.forEach((style) => pdf.addFont(font.file, font.name, style));
        })
      );

      // ── Layout constants ───────────────────────────────────────────────────
      const MARGIN        = 18;
      const pageWidth     = pdf.internal.pageSize.getWidth();
      const pageHeight    = pdf.internal.pageSize.getHeight();
      const contentWidth  = pageWidth - MARGIN * 2;
      // Colours from reference PDF
      const C_NAVY        : [number,number,number] = [15,  23,  42];
      const C_VIOLET      : [number,number,number] = [124, 58,  237];
      const C_SLATE       : [number,number,number] = [100, 116, 139];
      const C_MUTED       : [number,number,number] = [148, 163, 184];
      const C_BODY        : [number,number,number] = [51,  65,  85];
      const C_BORDER      : [number,number,number] = [226, 232, 240];
      const C_BG_LIGHT    : [number,number,number] = [248, 250, 252];
      const C_WHITE       : [number,number,number] = [255, 255, 255];
      const C_TAG_TEXT    : [number,number,number] = [71,  85,  105];

      let y = 0;
      let pageNum = 1;
      let totalPages = 1; // will be patched via jsPDF internal

      const FOOTER_Y = pageHeight - 8;
      const FOOTER_LABEL = `Viveka AI · AWESOME Qualitative Mapping Framework · ammachi labs / CWEGE`;

      // ── Helpers ────────────────────────────────────────────────────────────
      const lh = (fs: number) => fs * 0.50;   // line-height in mm for a given font-size

      const addPageFooter = () => {
        pdf.setFont('Latin', 'normal');
        pdf.setFontSize(6.5);
        pdf.setTextColor(...C_MUTED);
        pdf.text(FOOTER_LABEL, MARGIN, FOOTER_Y);
        pdf.text(`${pageNum} / {TOTAL}`, pageWidth - MARGIN, FOOTER_Y, { align: 'right' });
      };

      const newPage = () => {
        addPageFooter();
        pdf.addPage();
        pageNum += 1;
        totalPages += 1;
        y = MARGIN;
      };

      const checkBreak = (needed: number) => {
        if (y + needed > FOOTER_Y - 6) newPage();
      };

      const measureText = (text: string, fs: number, indent = 0): number => {
        const lines = pdf.splitTextToSize(text || '', contentWidth - indent);
        return lines.length * lh(fs) + 2;
      };

      /** Render wrapped text, returns new y */
      const addText = (
        text: string,
        fs: number,
        style = 'normal',
        color: [number,number,number] = C_NAVY,
        indent = 0,
        font = 'Latin',
        lineGap = 2
      ) => {
        pdf.setFontSize(fs);
        pdf.setFont(font, resolvePdfFontStyle(font, style));
        pdf.setTextColor(...color);
        const lines: string[] = pdf.splitTextToSize(text || '', contentWidth - indent);
        lines.forEach(line => {
          checkBreak(lh(fs));
          pdf.text(line, MARGIN + indent, y);
          y += lh(fs);
        });
        y += lineGap;
      };

      /** Thin micro-label above content (ORIGINAL SCRIPT / TRANSLITERATION / ENGLISH TRANSLATION) */
      const addFieldLabel = (label: string, indent = 0) => {
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(6.5);
        pdf.setTextColor(...C_MUTED);
        checkBreak(5);
        pdf.text(label, MARGIN + indent, y);
        y += 5;
      };

      /** Filled pill tag — e.g. "AGENCY SOCIAL" or "HOUSEHOLD · SOCIAL NORMS" */
      const addTag = (label: string, bgColor: [number,number,number], textColor: [number,number,number] = C_WHITE) => {
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(7);
        const textW = pdf.getTextWidth(label);
        const padH = 2.2, padV = 1.8;
        const pillW = textW + padH * 2;
        const pillH = 5.5;
        pdf.setFillColor(...bgColor);
        pdf.roundedRect(MARGIN, y, pillW, pillH, 1.5, 1.5, 'F');
        pdf.setTextColor(...textColor);
        pdf.text(label, MARGIN + padH, y + pillH - padV);
        y += pillH + 3;
      };

      /** Horizontal rule */
      const hRule = (color: [number,number,number] = C_BORDER, width = contentWidth, lw = 0.3) => {
        pdf.setDrawColor(...color);
        pdf.setLineWidth(lw);
        pdf.line(MARGIN, y, MARGIN + width, y);
        y += 4;
      };

      // ══════════════════════════════════════════════════════════════════════
      // PAGE 1 — COVER / HEADER
      // ══════════════════════════════════════════════════════════════════════
      y = MARGIN;

      // Violet top accent bar
      pdf.setFillColor(...C_VIOLET);
      pdf.rect(0, 0, pageWidth, 1.5, 'F');

      // Main title block
      y = MARGIN + 4;
      pdf.setFont('Latin', 'bold');
      pdf.setFontSize(22);
      pdf.setTextColor(...C_NAVY);
      pdf.text('Viveka AI', MARGIN, y);
      y += 8;

      pdf.setFont('Latin', 'normal');
      pdf.setFontSize(9);
      pdf.setTextColor(...C_SLATE);
      pdf.text('QUALITATIVE VERBATIM SPECIALIST', MARGIN, y);
      y += 5;

      pdf.setFont('Latin', 'bold');
      pdf.setFontSize(12);
      pdf.setTextColor(...C_NAVY);
      pdf.text('Research Dossier', MARGIN, y);
      pdf.setTextColor(...C_VIOLET);
      pdf.text(' AWESOME Framework', MARGIN + pdf.getTextWidth('Research Dossier'), y);
      y += 7;

      // "VIVEKA AI · HIGH-FIDELITY QUALITATIVE RESEARCH" badge
      const badgeLabel = 'VIVEKA AI  ·  HIGH-FIDELITY QUALITATIVE RESEARCH';
      pdf.setFont('Latin', 'bold');
      pdf.setFontSize(6.5);
      const badgeW = pdf.getTextWidth(badgeLabel) + 8;
      pdf.setFillColor(...C_NAVY);
      pdf.roundedRect(MARGIN, y, badgeW, 5.5, 1.5, 1.5, 'F');
      pdf.setTextColor(...C_WHITE);
      pdf.text(badgeLabel, MARGIN + 4, y + 3.8);
      y += 10;

      hRule(C_BORDER, contentWidth, 0.4);

      // Metadata info card
      const metaTop = y;
      const metaLines = [
        { label: 'DOCUMENT', value: originalFileName || 'Session_Archive' },
        { label: 'GENERATED', value: new Date().toLocaleString('en-GB', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }) },
      ];
      const metaCardH = metaLines.length * 9 + 6;
      pdf.setFillColor(...C_BG_LIGHT);
      pdf.setDrawColor(...C_BORDER);
      pdf.setLineWidth(0.3);
      pdf.roundedRect(MARGIN, metaTop, contentWidth, metaCardH, 3, 3, 'FD');
      y = metaTop + 7;
      metaLines.forEach(({ label, value }) => {
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(7);
        pdf.setTextColor(...C_MUTED);
        pdf.text(label, MARGIN + 5, y);
        pdf.setFont('Latin', 'normal');
        pdf.setFontSize(8.5);
        pdf.setTextColor(...C_NAVY);
        pdf.text(value, MARGIN + 30, y);
        y += 9;
      });
      y = metaTop + metaCardH + 10;

      // ── SUMMARY on cover ──────────────────────────────────────────────────
      if (result.summary) {
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(9);
        pdf.setTextColor(...C_MUTED);
        pdf.text('INTERVIEW SUMMARY', MARGIN, y);
        y += 7;

        const summaryLines: string[] = pdf.splitTextToSize(result.summary, contentWidth - 10);
        const summaryCardH = Math.max(20, summaryLines.length * lh(9.5) + 12);
        checkBreak(summaryCardH + 4);
        pdf.setFillColor(...C_WHITE);
        pdf.setDrawColor(...C_BORDER);
        pdf.setLineWidth(0.3);
        pdf.roundedRect(MARGIN, y, contentWidth, summaryCardH, 3, 3, 'FD');
        pdf.setFillColor(...C_VIOLET);
        pdf.rect(MARGIN, y, 2.5, summaryCardH, 'F');
        pdf.setFont('Latin', 'normal');
        pdf.setFontSize(9.5);
        pdf.setTextColor(...C_BODY);
        let sy = y + 7;
        summaryLines.forEach((line: string) => { pdf.text(line, MARGIN + 7, sy); sy += lh(9.5); });
        y += summaryCardH + 5;
      }

      addPageFooter();

      // ══════════════════════════════════════════════════════════════════════
      // VERBATIM TRANSCRIPT — one turn per block
      // ══════════════════════════════════════════════════════════════════════
      pdf.addPage(); pageNum++; totalPages++;
      y = MARGIN;

      pdf.setFillColor(...C_VIOLET);
      pdf.rect(0, 0, pageWidth, 1.5, 'F');

      pdf.setFont('Latin', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(...C_MUTED);
      pdf.text('VERBATIM TRANSCRIPT', MARGIN, y + 6);
      y += 14;
      hRule(C_BORDER);

      result.turns?.forEach((turn, idx) => {
        const turnNum = idx + 1;

        // Estimate block height for page-break decision
        const origH  = measureText(turn.original || '', 13, 5);
        const transH = turn.transliterated ? measureText(turn.transliterated, 9, 5) : 0;
        const tranE  = measureText(turn.translated || '', 9.5, 5);
        const blockH = 12 + 5 + origH + (turn.transliterated ? 5 + transH : 0) + 5 + tranE + 12;
        checkBreak(blockH);

        // Turn number circle
        const circR = 3.8;
        const circX = MARGIN + circR;
        const circY = y + circR + 1;
        pdf.setFillColor(...C_VIOLET);
        pdf.circle(circX, circY, circR, 'F');
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(7);
        pdf.setTextColor(...C_WHITE);
        pdf.text(`${turnNum}`, circX, circY + 2.2, { align: 'center' });

        // Speaker label
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(8);
        pdf.setTextColor(...C_NAVY);
        pdf.text(normalizeSpeakerLabel(turn.speaker).toUpperCase(), MARGIN + circR * 2 + 4, y + 6);

        // Timestamp pill (right-aligned)
        const tsLabel = turn.timestamp || formatSecondsForPdf(turn.start_time_seconds);
        pdf.setFont('Latin', 'normal');
        pdf.setFontSize(7);
        pdf.setTextColor(...C_SLATE);
        const tsW = pdf.getTextWidth(tsLabel) + 6;
        pdf.setFillColor(...C_BG_LIGHT);
        pdf.roundedRect(pageWidth - MARGIN - tsW, y + 1.5, tsW, 5, 1.5, 1.5, 'F');
        pdf.setTextColor(...C_SLATE);
        pdf.text(tsLabel, pageWidth - MARGIN - tsW + 3, y + 5.5);
        y += 11;

        // Vertical left accent line for the whole turn block
        const turnBlockTopY = y;

        // ORIGINAL SCRIPT
        addFieldLabel('ORIGINAL SCRIPT', 5);
        const origFont = detectFontFamily(turn.original);
        addText(turn.original || '', 13, 'bold', C_NAVY, 5, origFont, 5);

        // TRANSLITERATION
        if (turn.transliterated) {
          addFieldLabel('TRANSLITERATION', 5);
          addText(turn.transliterated, 9, 'normal', C_SLATE, 5, 'Latin', 4);
        }

        // ENGLISH TRANSLATION — slight indent box
        addFieldLabel('ENGLISH TRANSLATION', 5);
        const transLines = pdf.splitTextToSize(turn.translated || '', contentWidth - 10);
        const transBlockH = transLines.length * lh(9.5) + 6;
        checkBreak(transBlockH);
        pdf.setFillColor(250, 251, 253);
        pdf.setDrawColor(...C_BORDER);
        pdf.setLineWidth(0.25);
        pdf.roundedRect(MARGIN + 5, y, contentWidth - 5, transBlockH, 2, 2, 'FD');
        // left violet accent on translation box
        pdf.setFillColor(...C_VIOLET);
        pdf.rect(MARGIN + 5, y, 2, transBlockH, 'F');
        pdf.setFont('Latin', 'normal');
        pdf.setFontSize(9.5);
        pdf.setTextColor(...C_BODY);
        let ty2 = y + 4;
        transLines.forEach((line: string) => { pdf.text(line, MARGIN + 10, ty2); ty2 += lh(9.5); });
        y += transBlockH + 5;

        // Left accent bar for whole turn block
        pdf.setFillColor(...C_VIOLET);
        pdf.rect(MARGIN, turnBlockTopY - 3, 1.5, y - turnBlockTopY + 2, 'F');

        // Bottom separator
        hRule(C_BORDER, contentWidth, 0.25);
      });


      addPageFooter();

      // ── Patch page numbers (replace {TOTAL} placeholder) ─────────────────
      // jsPDF doesn't support auto page-count; we generate, save, done.
      // Patch: re-iterate internal pages to replace {TOTAL}
      const totalStr = String(totalPages);
      // jsPDF stores text ops internally — we use a second-pass approach:
      // Simply rely on totalPages counter we tracked ourselves.
      // The footer already wrote `pageNum / {TOTAL}` — we need to overwrite those.
      // Simplest approach: iterate pages we know and overwrite footer right-side.
      const savedY = y;
      for (let p = 1; p <= totalPages; p++) {
        (pdf as any).setPage(p);
        // white-out the placeholder then rewrite
        pdf.setFillColor(255, 255, 255);
        pdf.rect(pageWidth - MARGIN - 18, FOOTER_Y - 4, 18, 5, 'F');
        pdf.setFont('Latin', 'normal');
        pdf.setFontSize(6.5);
        pdf.setTextColor(...C_MUTED);
        pdf.text(`${p} / ${totalStr}`, pageWidth - MARGIN, FOOTER_Y, { align: 'right' });
      }

      // ── Save ───────────────────────────────────────────────────────────────
      const safeFilename = (originalFileName || 'session')
        .replace(/\.[^/.]+$/, '')
        .replace(/[^a-zA-Z0-9_\-]/g, '_')
        .slice(0, 40);
      const fileName = `Viveka_${safeFilename}_${Date.now()}.pdf`;
      pdf.save(fileName);
      const apiBase = TRANSCRIPTION_API_URL?.replace("/api/transcribe", "") || "";

      if (sessionId) {
        await fetch(
          `${apiBase}/api/admin/activity/${sessionId}/flag?flag=pdf_dossier_downloaded`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${getAccessToken() || ""}`,
            },
          }
        );
      }
      
      const blob = pdf.output('blob');
      try {
        await uploadToMinio(new File([blob], fileName, { type: 'application/pdf' }));
      } catch (error) {
        console.warn('Skipping dossier sync upload:', error);
      }

    } catch (error: any) {
      console.error("Dossier Synthesis Protocol Violation:", error);
      alert(`Synthesis Error: ${error.message || "Archive data incomplete."}`);
    } finally {
      setIsExporting(false);
    }
  };

  return (
    <div className="space-y-8 animate-fade-in pb-20">
      <div className="flex flex-col md:flex-row justify-between items-center gap-6 bg-white dark:bg-slate-950 p-6 rounded-[2.5rem] shadow-sm border border-slate-100">
        <div className="flex items-center gap-5">
           <div className="p-4 bg-violet-100 rounded-3xl text-violet-600 shadow-inner">
             <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
             </svg>
           </div>
           <div>
             <h2 className="text-lg font-black text-slate-900 tracking-tight leading-tight truncate max-w-[280px]" title={originalFileName || 'Research Archive'}>{originalFileName || 'Research Archive'}</h2>
             <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full shrink-0"></span>
                <p className="text-[9px] font-black text-slate-400 uppercase tracking-[0.15em]">High-Fidelity Verbatim Sync Active</p>
                {processingTimeTaken != null && (
                  <span className="px-2 py-0.5 bg-emerald-50 border border-emerald-200 text-emerald-700 text-[8px] font-black uppercase tracking-widest rounded-full">
                    ⏱ {Math.floor(processingTimeTaken / 60)}m {processingTimeTaken % 60}s
                  </span>
                )}
             </div>
           </div>
        </div>

        {/* Tab switcher + export actions — two-row layout to prevent overflow */}
        <div className="flex flex-col gap-3 items-end shrink-0">
          {/* Row 1: Tab switcher */}
          <div className="flex p-1 bg-slate-100 rounded-xl shadow-inner">
            <button
              onClick={() => setActiveTab('transcript')}
              className="px-5 py-2 rounded-lg text-[9px] font-black uppercase tracking-widest bg-white dark:bg-slate-950 shadow text-slate-900"
            >Transcript</button>
            <button
              disabled
              className="px-5 py-2 rounded-lg text-[9px] font-black uppercase tracking-widest text-slate-300 cursor-not-allowed flex items-center gap-1.5"
              title="Coming soon"
            >
              Artifacts
              <span className="text-[7px] bg-amber-100 text-amber-600 px-1.5 py-0.5 rounded-full font-black uppercase">Soon</span>
            </button>
          </div>

          {/* Row 2: Export buttons — icon + short label, compact */}
          <div className="flex items-center gap-2">
            {/* Export PDF */}
            <button
              onClick={generatePDF}
              disabled={isExporting}
              title="Export PDF Dossier"
              className={`flex items-center gap-1.5 px-3 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest transition-all shadow active:scale-95
                ${isExporting ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-slate-900 text-white hover:bg-violet-600'}`}
            >
              {isExporting
                ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              }
              PDF
            </button>

            {/* Word */}
            <button
              onClick={generateWord}
              title="Download Word Document"
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest bg-blue-600 text-white hover:bg-blue-700 transition-all shadow active:scale-95"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 3h8l5 5v13a1 1 0 01-1 1H7a2 2 0 01-2-2V5a2 2 0 012-2z" /></svg>
              Word
            </button>

            {/* CSV */}
            <button
              onClick={async () => {
                  const base = (originalFileName || "transcript")
                      .replace(/\.[^/.]+$/, "")
                      .replace(/[^a-zA-Z0-9_-]/g, "_")
                      .slice(0, 40);

                  downloadCsv(result.turns, `${base}_transcript.csv`);

                  const apiBase = TRANSCRIPTION_API_URL?.replace("/api/transcribe", "") || "";

                  if (sessionId) {
                      await fetch(
                          `${apiBase}/api/admin/activity/${sessionId}/flag?flag=csv_downloaded`,
                          {
                              method: "POST",
                              headers: {
                                  Authorization: `Bearer ${getAccessToken() || ""}`,
                              },
                          }
                      );
                  }
              }}
              title="Download CSV Transcript"
              className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest bg-emerald-600 text-white hover:bg-emerald-700 transition-all shadow active:scale-95"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
              CSV
            </button>

            {/* Email */}
            <button
                disabled
                title="Email Dossier (Coming Soon)"
                className="flex items-center gap-1.5 px-3 py-2 rounded-xl text-[9px] font-black uppercase tracking-widest bg-slate-200 text-slate-400 cursor-not-allowed shadow"
              >
              {isSendingEmail
                ? <div className="w-3.5 h-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" /></svg>
              }
              Email(coming soon)
            </button>
          </div>
        </div>
      </div>
      {emailStatus && (
        <div className={`px-6 py-3 rounded-2xl text-sm font-bold text-center ${emailStatus.startsWith('Failed') ? 'bg-rose-50 text-rose-600 border border-rose-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}>
          {emailStatus}
        </div>
      )}

      <div className="bg-white dark:bg-slate-950 rounded-[4.5rem] shadow-2xl shadow-slate-200/50 border border-slate-100 p-12 md:p-24 overflow-hidden relative min-h-[600px]">
        {audioUrl && (
          <div className="mb-8 p-4 rounded-2xl border border-slate-100 bg-slate-50">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Session Audio</p>
            <audio controls src={audioUrl} className="w-full" />
          </div>
        )}
        <TranscriptView result={result} />
      </div>
    </div>
  );
};
