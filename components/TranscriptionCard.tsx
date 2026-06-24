/**
import React, { useState } from 'react';
import { TranscriptionResult } from '../types';
import { jsPDF } from 'jspdf';
import { uploadToMinio } from '../services/minio.service';
import { useRef } from "react";
import { useReactToPrint } from "react-to-print";


interface Props {
    result: TranscriptionResult;
    audioUrl?: string;
    originalFileName?: string;
    originalFile?: File;
}

const s = (val: any): string => val?.toString() || "";

const FONT_LIST = [
    { name: "Latin", style: "normal", file: "NotoSans-Regular.ttf" },
    { name: "Malayalam", style: "normal", file: "NotoSansMalayalam-Regular.ttf" },
    { name: "Devanagari", style: "normal", file: "NotoSans-Regular.ttf" },
    { name: "Oriya", style: "normal", file: "NotoSansOriya-Regular.ttf" },
    { name: "English", style: "normal", file: "NotoSans-Regular.ttf" },
    { name: "Tamil", style: "normal", file: "NotoSans-Regular.ttf" },
];


let fontCache: Record<string, string> = {};

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
    if (/[\u0C80-\u0CFF]/.test(text)) return 'Latin'; //kannada
    if (/[\u0600-\u06FF]/.test(text)) return 'Latin'; //Arabic
    return 'Latin';
}

function formatTimestamp(ts: string): string {
  if (!ts) return "00:00";

  // If already MM:SS → keep it
  if (/^\d{2}:\d{2}$/.test(ts)) {
    return ts;
  }

  // If seconds only (e.g. "10")
  if (/^\d+$/.test(ts)) {
    const sec = Number(ts);
    const mm = Math.floor(sec / 60);
    const ss = sec % 60;
    return `${mm.toString().padStart(2, "0")}:${ss
      .toString()
      .padStart(2, "0")}`;
  }

  // Fallback
  return ts;
}


const TranscriptView: React.FC<{ result: TranscriptionResult }> = ({ result }) => (
    <div className="max-w-4xl mx-auto space-y-12 bg-white">
        <div className="space-y-6">
            <h3 className="text-3xl font-black text-slate-900 border-b-8 border-slate-900 pb-3 uppercase tracking-tighter">Executive Synthesis</h3>
            <div className="space-y-8 text-xl leading-relaxed text-slate-800 font-serif text-justify">
                {result.executiveSynthesis?.map((chunk, i) => (
                    <div key={i} className="relative">
                        <span className="font-black text-slate-900 bg-slate-100 px-3 py-1 rounded-lg text-sm mr-2 align-middle">
                            Chunk {chunk.chunk_id}
                        </span>
                        <span className="align-middle">{chunk.text}</span>
                    </div>
                ))}
            </div>
        </div>
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
                                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Timeline Sync</span>
                                <span className="text-sm bg-slate-900 text-white px-4 py-1.5 rounded-xl font-mono font-bold shadow-lg shadow-slate-200">
                                    {formatTimestamp(turn.timestamp)}

                                </span>
                            </div>
                        </div>
                        <div className="pl-8 space-y-6 border-l-8 border-slate-50 group-hover:border-violet-200 transition-colors">                            
                                                   
                            {turn.transliterated && (
                                <div className="space-y-2">
                                    <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Phonetic Record</p>
                                    <div className="text-base font-bold text-slate-400 italic tracking-tight">{s(turn.transliterated)}</div>
                                </div>
                            )}
                            <div className="space-y-3 pt-4 border-t border-slate-50">
                                <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">English Analysis Tier</p>
                                <div className="text-2xl text-slate-700 font-serif leading-relaxed italic">"{s(turn.translated)}"</div>
                            </div>
                        </div>
                    </div>
                ))}
            </div>
        </div>
    </div>
);

const ArtifactsView: React.FC<{ result: TranscriptionResult }> = ({ result }) => (
    <div className="max-w-4xl mx-auto space-y-16">
        <section className="space-y-6">
            <h3 className="text-3xl font-black text-slate-900 border-b-8 border-slate-900 pb-3 uppercase tracking-tighter">Artifact 1: Evidence Matrix</h3>
            <div className="grid grid-cols-1 gap-6">
                {result.artifact1_evidence?.map((row, i) => (
                    <div key={i} className="bg-white border-2 border-slate-100 p-8 rounded-3xl shadow-sm">
                        <div className="flex gap-4 mb-4">
                            <span className="bg-violet-100 text-violet-700 px-4 py-1 rounded-full text-[10px] font-black uppercase tracking-wider">{row.dimension}</span>
                            <span className="bg-amber-100 text-amber-700 px-4 py-1 rounded-full text-[10px] font-black uppercase tracking-wider">{row.domain}</span>
                        </div>
                        <p className="text-2xl font-serif italic text-slate-800 leading-relaxed mb-6">"{row.evidence}"</p>
                        <div className="bg-slate-50 p-6 rounded-2xl">
                            <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Systemic Reasoning</p>
                            <p className="text-base text-slate-600 font-medium">{row.reasoning}</p>
                        </div>
                    </div>
                ))}
            </div>
        </section>

        <section className="space-y-6">
            <h3 className="text-3xl font-black text-slate-900 border-b-8 border-slate-900 pb-3 uppercase tracking-tighter">Artifact 2: Context Matrix</h3>
            <div className="overflow-hidden rounded-3xl border-2 border-slate-100 shadow-sm">
                <table className="w-full text-left border-collapse">
                    <thead className="bg-slate-900 text-white text-[10px] font-black uppercase tracking-[0.2em]">
                        <tr>
                            <th className="p-6">Context Level</th>
                            <th className="p-6">Domain</th>
                            <th className="p-6">Key Finding</th>
                        </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                        {result.artifact2_context?.map((row, i) => (
                            <tr key={i} className="hover:bg-slate-50 transition-colors">
                                <td className="p-6 font-black text-slate-900 text-lg">{row.contextLevel}</td>
                                <td className="p-6 font-bold text-violet-600">{row.domain}</td>
                                <td className="p-6 text-slate-600 font-medium italic">{row.finding}</td>
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
        </section>

        <div className="grid grid-cols-1 gap-12">
            <section className="space-y-6">
                <h3 className="text-3xl font-black text-slate-900 border-b-8 border-slate-900 pb-3 uppercase tracking-tighter">Artifact 3: Mechanism Chains</h3>
                <div className="space-y-6">
                    {result.artifact3_chains?.map((chain, i) => (
                        <div key={i} className="flex items-start gap-8 bg-slate-900 text-white p-10 rounded-[3rem] shadow-2xl relative overflow-hidden">
                            <div className="absolute top-0 right-0 p-8 opacity-10">
                                <svg className="w-24 h-24" fill="currentColor" viewBox="0 0 24 24"><path d="M13 3l-2 3H2v15h19V3h-8zm0 5h6v11H4V8h7l2-3z" /></svg>
                            </div>
                            <div className="w-20 h-20 bg-violet-600 rounded-2xl flex items-center justify-center shrink-0 text-3xl font-black shadow-lg">{chain.chain_id}</div>
                            <div className="space-y-6">
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-[0.4em] text-violet-400 mb-2">Systemic Pathway</p>
                                    <p className="text-3xl font-bold tracking-tight">{chain.pathway}</p>
                                </div>
                                <div className="h-px bg-white/10 w-full"></div>
                                <div>
                                    <p className="text-[10px] font-black uppercase tracking-[0.4em] text-amber-400 mb-2">Impact Synthesis</p>
                                    <p className="text-xl text-slate-300 italic leading-relaxed">{chain.impacts}</p>
                                </div>
                            </div>
                        </div>
                    ))}
                </div>
            </section>

            <section className="space-y-6">
                <h3 className="text-3xl font-black text-slate-900 border-b-8 border-slate-900 pb-3 uppercase tracking-tighter">Artifact 5: Vulnerability Hotspots</h3>
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                    {result.artifact5_hotspots?.map((item, i) => (
                        <div key={i} className="bg-rose-50 border-2 border-rose-100 p-10 rounded-[3rem] relative overflow-hidden">
                            <div className="bg-rose-600 w-1.5 h-12 absolute left-0 top-12 rounded-r-full"></div>
                            <p className="text-[11px] font-black uppercase tracking-[0.4em] text-rose-600 mb-3">Vulnerable Hotspot</p>
                            <p className="text-3xl font-black text-slate-900 mb-6">{item.vulnerable}</p>
                            <div className="bg-white/60 p-6 rounded-2xl border border-rose-100 shadow-inner">
                                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Causal Drivers</p>
                                <p className="text-lg text-slate-600 font-medium leading-snug">{item.drivers}</p>
                            </div>
                        </div>
                    ))}
                </div>
            </section>
        </div>
    </div>
);

export const TranscriptionCard: React.FC<Props> = ({ result, originalFileName }) => {
    const [activeTab, setActiveTab] = useState<'transcript' | 'artifacts'>('transcript');
    const [isExporting, setIsExporting] = useState(false);

    const printRef = useRef<HTMLDivElement>(null);

const handlePrint = useReactToPrint({
  contentRef: printRef,
  documentTitle: `Viveka_Dossier_${Date.now()}`,
});



    

    const generatePDF = async () => {
        setIsExporting(true);
        const folderPath = "/fonts/";
        const doc = new jsPDF({ orientation: 'p', unit: 'mm', format: 'a4' });

        try {
            const neededFonts = new Set(['Latin']);
            result.turns.forEach(t => neededFonts.add(detectFontFamily(t.original)));

            const loadPromises = FONT_LIST.filter(f => neededFonts.has(f.name)).map(async (fontInfo) => {
                let base64Data = fontCache[fontInfo.name];
                if (!base64Data) {
                    const response = await fetch(`${folderPath}${fontInfo.file}`);
                    if (!response.ok) return;
                    const arrayBuffer = await response.arrayBuffer();
                    base64Data = arrayBufferToBase64(arrayBuffer);
                    fontCache[fontInfo.name] = base64Data;
                }
                doc.addFileToVFS(fontInfo.file, base64Data);
                doc.addFont(fontInfo.file, fontInfo.name, "normal");
            });

            await Promise.all(loadPromises);

            const margin = 20;
            const pageWidth = doc.internal.pageSize.getWidth();
            const contentWidth = pageWidth - (margin * 2);
            const pageHeight = doc.internal.pageSize.getHeight();
            let y = 25;

            const checkPageBreak = (needed: number) => {
                if (y + needed > pageHeight - 20) {
                    doc.addPage();
                    y = 20;
                }
            };

            const addWrappedText = (text: string, fontSize: number, fontName: string = "Latin", style: string = 'normal', color: [number, number, number] = [30, 41, 59], indent: number = 0) => {
                doc.setFont(fontName, style);
                doc.setFontSize(fontSize);
                doc.setTextColor(color[0], color[1], color[2]);
                const lines: string[] = doc.splitTextToSize(text || "", contentWidth - indent);
                const lineHeight = fontSize * 0.65;
                lines.forEach(line => {
                    checkPageBreak(lineHeight);
                    doc.text(line, margin + indent, y);
                    y += lineHeight;
                });
                y += 2;
            };

            // Header
            doc.setFillColor(0, 0, 0); // pure black
doc.rect(margin, y, contentWidth, 16, 'F');

doc.setTextColor(255, 255, 255);
doc.setFont("Latin", "bold");
doc.setFontSize(14);
doc.text(
  "VIVEKA RESEARCH DOSSIER - VERBATIM SYNTHESIS",
  margin + contentWidth / 2,
  y + 11,
  { align: "center" }
);

y += 22;



            doc.setTextColor(100, 116, 139);
            doc.text(`FILE: ${originalFileName || "Session_Archive"}`, margin, y);
            doc.text(`SYNCED: ${new Date().toLocaleString()}`, margin, y + 4);
            y += 15;

            // Executive Synthesis
            addWrappedText("EXECUTIVE SYNTHESIS", 12, "Latin", 'bold', [15, 23, 42]);
            result.executiveSynthesis?.forEach(chunk => {
                addWrappedText(`[Chunk ${chunk.chunk_id}] ${chunk.text}`, 10, "Latin", 'normal', [71, 85, 105]);
                y += 4;
            });

            y += 10;

            // Verbatim Record
            addWrappedText("VERBATIM RECORD", 12, "Latin", 'bold', [15, 23, 42]);
            result.turns?.forEach((turn) => {
                checkPageBreak(40);
                doc.setFillColor(248, 250, 252);
                doc.rect(margin, y, contentWidth, 10, 'F');
                addWrappedText(
  `${turn.speaker.toUpperCase()} - MU ${turn.mu_id}  ${formatTimestamp(turn.timestamp)}`,
  9,
  "Latin",
  'bold',
  [15, 23, 42],
  3
);

                y += 2;

                addWrappedText(`TRANSLITERATION RECORD:\n${turn.transliterated}`, 10, "Latin",'normal',[71, 85, 105]);

                if (turn.translated) {
                    addWrappedText(`Analysis: ${turn.translated}`, 10, "Latin", 'italic', [51, 65, 85], 5);
                }
                y += 5;
            });

            // 4. Artifacts Sections
            doc.addPage();
            y = 20;
            addWrappedText("QUALITATIVE MAPPING ARTIFACTS", 14, "Latin", 'bold', [15, 23, 42]);
            y += 10;

            // Artifact 1: Evidence Matrix
            addWrappedText("ARTIFACT 1: EVIDENCE MATRIX", 11, "Latin", 'bold', [124, 58, 237]);
            result.artifact1_evidence?.forEach(row => {
                checkPageBreak(40);
                y += 5;
                doc.setFont("Latin", "bold");
                doc.setFontSize(8);
                doc.setTextColor(124, 58, 237);
                doc.text(`${row.dimension} | ${row.domain}`, margin + 5, y);
                y += 6;
                addWrappedText(`Evidence: "${row.evidence}"`, 9, detectFontFamily(row.evidence), 'italic', [30, 41, 59], 5);
                addWrappedText(`Reasoning: ${row.reasoning}`, 8, detectFontFamily(row.reasoning), 'normal', [100, 116, 139], 5);
            });

            // Artifact 2: Context Matrix
            // Artifact 2: Context Matrix
y += 10;
addWrappedText("ARTIFACT 2: CONTEXT MATRIX", 12, "Latin", 'bold', [15, 23, 42]);
y += 4;

result.artifact2_context?.forEach(row => {
    checkPageBreak(35);

    // Row header
    doc.setFont("Latin", "bold");
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text(`${row.contextLevel} | ${row.domain}`, margin + 5, y);

    y += 6; // 
    // Finding text
    addWrappedText(
        row.finding,
        9,
        detectFontFamily(row.finding),
        'normal',
        [71, 85, 105],
        5
    );

    y += 6; // 🔑 space between rows
});


            // Artifact 3: Mechanism Chains
            y += 10;
            addWrappedText("ARTIFACT 3: MECHANISM CHAINS", 11, "Latin", 'bold', [124, 58, 237]);
            result.artifact3_chains?.forEach(chain => {
                checkPageBreak(30);
                doc.setFillColor(15, 23, 42);
                doc.rect(margin, y, 12, 12, 'F');
                doc.setTextColor(255, 255, 255);
                doc.setFontSize(10);
                doc.text(s(chain?.chain_id), margin + 4, y + 8);
                addWrappedText(chain?.pathway, 10, detectFontFamily(chain?.pathway), 'bold', [15, 23, 42], 20);
                addWrappedText(chain?.impacts, 9, detectFontFamily(chain?.impacts), 'italic', [100, 116, 139], 20);
            });

            // Artifact 5: Vulnerability Hotspots
            y += 10;
            addWrappedText("ARTIFACT 5: VULNERABILITY HOTSPOTS", 12, "Latin", 'bold', [225, 29, 72]);
            result.artifact5_hotspots?.forEach(item => {
                checkPageBreak(30);
                addWrappedText(item.vulnerable, 10, detectFontFamily(item.vulnerable), 'bold', [15, 23, 42], 5);
                addWrappedText(`Drivers: ${item.drivers}`, 9, detectFontFamily(item.drivers), 'normal', [153, 27, 27], 5);
            });

            const fileName = `Viveka_Dossier_${Date.now()}.pdf`;
            doc.save(fileName);
            const blob = doc.output('blob');
            try {
              await uploadToMinio(new File([blob], fileName, { type: 'application/pdf' }));
            } catch (error) {
              console.warn('Skipping dossier sync upload:', error);
            }

        } catch (error: any) {
            console.error("PDF Export Failed:", error);
        } finally {
            setIsExporting(false);
        }
    };

    return (
        <div className="space-y-8 animate-fade-in pb-20">
            <div className="flex flex-col md:flex-row justify-between items-center gap-6 bg-white p-6 rounded-[2.5rem] shadow-sm border border-slate-100">
                <div className="flex items-center gap-5">
                    <div className="p-4 bg-violet-100 rounded-3xl text-violet-600 shadow-inner">
                        <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                    </div>
                    <div>
                        <h2 className="text-2xl font-black text-slate-900 tracking-tight leading-tight">{originalFileName || 'Research Archive'}</h2>
                    </div>
                </div>
                <div className="flex items-center gap-4">
                    <div className="flex p-1.5 bg-slate-100 rounded-2xl shadow-inner">
                        <button onClick={() => setActiveTab('transcript')} className={`px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'transcript' ? 'bg-white shadow-md text-slate-900' : 'text-slate-400'}`}>Transcript</button>
                        <button onClick={() => setActiveTab('artifacts')} className={`px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'artifacts' ? 'bg-white shadow-md text-slate-900' : 'text-slate-400'}`}>Artifacts</button>
                    </div>
                    <button onClick={generatePDF} disabled={isExporting} className="p-4 rounded-2xl bg-slate-900 text-white flex items-center gap-2">
                        {isExporting ? <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div> : <span className="text-[10px] font-black uppercase tracking-widest">Export Dossier</span>}
                    </button>
                </div>
            </div>
            <div 
            ref={printRef}
            className="bg-white rounded-[4.5rem] shadow-2xl p-12 md:p-24 relative min-h-[600px]">
                {activeTab === 'transcript' ? <TranscriptView result={result} /> : <ArtifactsView result={result} />}
            </div>
        </div>
    );
};


**/


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
}

const s = (val: any): string => val?.toString() || "";

const TranscriptView: React.FC<{ result: TranscriptionResult }> = ({ result }) => (
  <div className="max-w-4xl mx-auto space-y-12 bg-white">
    <div className="space-y-6">
      <h3 className="text-3xl font-black text-slate-900 border-b-8 border-slate-900 pb-3 uppercase tracking-tighter">Summary Of Interview</h3>
      <div className="space-y-8 text-xl leading-relaxed text-slate-800 font-serif text-justify">
        {result.executiveSynthesis?.map((chunk, i) => (
          <div key={i} className="relative">
            <span className="font-black text-slate-900 bg-slate-100 px-3 py-1 rounded-lg text-sm mr-2 align-middle">
              Summary {chunk.chunk_id}
            </span>
            <span className="align-middle">{chunk.text}</span>
          </div>
        ))}
      </div>
    </div>

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

const ArtifactsView: React.FC<{ result: TranscriptionResult }> = ({ result }) => (
  <div className="max-w-4xl mx-auto space-y-16">
    <section className="space-y-6">
       <h3 className="text-3xl font-black text-slate-900 border-b-8 border-slate-900 pb-3 uppercase tracking-tighter">Artifact 1: Evidence Matrix</h3>
       <div className="grid grid-cols-1 gap-6">
         {result.artifact1_evidence?.map((row, i) => (
           <div key={i} className="bg-white border-2 border-slate-100 p-8 rounded-3xl shadow-sm">
             <div className="flex gap-4 mb-4">
               <span className="bg-violet-100 text-violet-700 px-4 py-1 rounded-full text-[10px] font-black uppercase tracking-wider">{row.dimension}</span>
               <span className="bg-amber-100 text-amber-700 px-4 py-1 rounded-full text-[10px] font-black uppercase tracking-wider">{row.domain}</span>
             </div>
             <p className="text-2xl font-serif italic text-slate-800 leading-relaxed mb-6">"{row.evidence}"</p>
             <div className="bg-slate-50 p-6 rounded-2xl">
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Systemic Reasoning</p>
                <p className="text-base text-slate-600 font-medium">{row.reasoning}</p>
             </div>
           </div>
         ))}
       </div>
    </section>

    <section className="space-y-6">
       <h3 className="text-3xl font-black text-slate-900 border-b-8 border-slate-900 pb-3 uppercase tracking-tighter">Artifact 2: Context Matrix</h3>
       <div className="overflow-hidden rounded-3xl border-2 border-slate-100 shadow-sm">
         <table className="w-full text-left border-collapse">
           <thead className="bg-slate-900 text-white text-[10px] font-black uppercase tracking-[0.2em]">
             <tr>
               <th className="p-6">Context Level</th>
               <th className="p-6">Domain</th>
               <th className="p-6">Key Finding</th>
             </tr>
           </thead>
           <tbody className="divide-y divide-slate-100">
             {result.artifact2_context?.map((row, i) => (
               <tr key={i} className="hover:bg-slate-50 transition-colors">
                 <td className="p-6 font-black text-slate-900 text-lg">{row.contextLevel}</td>
                 <td className="p-6 font-bold text-violet-600">{row.domain}</td>
                 <td className="p-6 text-slate-600 font-medium italic">{row.finding}</td>
               </tr>
             ))}
           </tbody>
         </table>
       </div>
    </section>

    <div className="grid grid-cols-1 gap-12">
      <section className="space-y-6">
         <h3 className="text-3xl font-black text-slate-900 border-b-8 border-slate-900 pb-3 uppercase tracking-tighter">Artifact 3: Mechanism Chains</h3>
         <div className="space-y-6">
           {result.artifact3_chains?.map((chain, i) => (
             <div key={i} className="flex items-start gap-8 bg-slate-900 text-white p-10 rounded-[3rem] shadow-2xl relative overflow-hidden">
               <div className="absolute top-0 right-0 p-8 opacity-10">
                 <svg className="w-24 h-24" fill="currentColor" viewBox="0 0 24 24"><path d="M13 3l-2 3H2v15h19V3h-8zm0 5h6v11H4V8h7l2-3z"/></svg>
               </div>
               <div className="w-20 h-20 bg-violet-600 rounded-2xl flex items-center justify-center shrink-0 text-3xl font-black shadow-lg">{chain.chain_id}</div>
               <div className="space-y-6">
                 <div>
                   <p className="text-[10px] font-black uppercase tracking-[0.4em] text-violet-400 mb-2">Systemic Pathway</p>
                   <p className="text-3xl font-bold tracking-tight">{chain.pathway}</p>
                 </div>
                 <div className="h-px bg-white/10 w-full"></div>
                 <div>
                   <p className="text-[10px] font-black uppercase tracking-[0.4em] text-amber-400 mb-2">Impact Synthesis</p>
                   <p className="text-xl text-slate-300 italic leading-relaxed">{chain.impacts}</p>
                 </div>
               </div>
             </div>
           ))}
         </div>
      </section>

      <section className="space-y-6">
         <h3 className="text-3xl font-black text-slate-900 border-b-8 border-slate-900 pb-3 uppercase tracking-tighter">Artifact 4: Vulnerability Hotspots</h3>
         <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
           {result.artifact5_hotspots?.map((item, i) => (
             <div key={i} className="bg-rose-50 border-2 border-rose-100 p-10 rounded-[3rem] relative overflow-hidden">
               <div className="bg-rose-600 w-1.5 h-12 absolute left-0 top-12 rounded-r-full"></div>
               <p className="text-[11px] font-black uppercase tracking-[0.4em] text-rose-600 mb-3">Vulnerable Hotspot</p>
               <p className="text-3xl font-black text-slate-900 mb-6">{item.vulnerable}</p>
               <div className="bg-white/60 p-6 rounded-2xl border border-rose-100 shadow-inner">
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2">Causal Drivers</p>
                  <p className="text-lg text-slate-600 font-medium leading-snug">{item.drivers}</p>
               </div>
             </div>
           ))}
         </div>
      </section>
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

const buildExecutiveSynthesisText = (result: TranscriptionResult) => {
  const synthesis = (result.executiveSynthesis || [])
    .map((chunk) => (chunk.text || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();

  if (synthesis) {
    return synthesis;
  }

  const summary = (result.summary || '').trim();
  if (summary) {
    return summary;
  }

  const translatedTurns = (result.turns || [])
    .slice(0, 3)
    .map((turn) => (turn.translated || turn.original || '').trim())
    .filter(Boolean)
    .join(' ')
    .trim();

  return translatedTurns || 'Transcript available. No synthesis content was generated for this export.';
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

export const TranscriptionCard: React.FC<Props> = ({ result, audioUrl, originalFileName, onRestart }) => {
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
      const executiveText = buildExecutiveSynthesisText(result);
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
      addText('SUMMARY OF INTERVIEW', 13, 'bold', [15,23,42]);
      addText(executiveText, 10, 'italic', [51,65,85], 8, detectFontFamily(executiveText));
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
      const formData = new FormData();
      formData.append('recipient_email', recipientEmail);
      formData.append('filename', fileName);
      formData.append('original_filename', originalFileName || '');
      formData.append('pdf', new File([blob], fileName, { type: 'application/pdf' }));
      const apiBase = TRANSCRIPTION_API_URL?.replace('/api/transcribe', '') || '';
      const res = await fetch(`${apiBase}/api/send-pdf`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${getAccessToken() || ''}` },
        body: formData,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: 'Unknown error' }));
        throw new Error(err.detail || `HTTP ${res.status}`);
      }
      setEmailStatus(`Dossier sent to ${recipientEmail}`);
    } catch (err: any) {
      setEmailStatus(`Failed: ${err.message}`);
    } finally {
      setIsSendingEmail(false);
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

      // ── EXECUTIVE SYNTHESIS on cover ──────────────────────────────────────
      pdf.setFont('Latin', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(...C_MUTED);
      pdf.text('EXECUTIVE SYNTHESIS', MARGIN, y);
      y += 7;

      const execItems = (result.executiveSynthesis || []).filter(cs => cs.text?.trim());
      if (execItems.length === 0 && result.summary) {
        execItems.push({ chunk_id: 1, text: result.summary });
      }

      execItems.forEach((cs, idx) => {
        const textH = measureText(cs.text, 9.5, 0);
        const cardH = Math.max(22, textH + 14);
        checkBreak(cardH + 4);

        // Card background
        pdf.setFillColor(...C_WHITE);
        pdf.setDrawColor(...C_BORDER);
        pdf.setLineWidth(0.3);
        pdf.roundedRect(MARGIN, y, contentWidth, cardH, 3, 3, 'FD');

        // Numbered badge (filled circle)
        const badgeR = 3.8;
        pdf.setFillColor(...C_VIOLET);
        pdf.circle(MARGIN + badgeR + 4, y + badgeR + 5, badgeR, 'F');
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(7);
        pdf.setTextColor(...C_WHITE);
        pdf.text(`${idx + 1}`, MARGIN + badgeR + 4, y + badgeR + 5 + 2.2, { align: 'center' });

        const textX = MARGIN + badgeR * 2 + 10;
        const textW = contentWidth - badgeR * 2 - 14;
        pdf.setFont('Latin', 'normal');
        pdf.setFontSize(9.5);
        pdf.setTextColor(...C_BODY);
        const lines: string[] = pdf.splitTextToSize(cs.text, textW);
        let ty = y + 8;
        lines.forEach(line => { pdf.text(line, textX, ty); ty += lh(9.5); });
        y += cardH + 5;
      });

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

      // ══════════════════════════════════════════════════════════════════════
      // ARTIFACT 1 — EVIDENCE MATRIX
      // ══════════════════════════════════════════════════════════════════════
      pdf.addPage(); pageNum++; totalPages++;
      y = MARGIN;
      pdf.setFillColor(...C_VIOLET);
      pdf.rect(0, 0, pageWidth, 1.5, 'F');

      pdf.setFont('Latin', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(...C_MUTED);
      pdf.text('ARTIFACT 1 — EVIDENCE MATRIX', MARGIN, y + 6);
      y += 14;
      hRule(C_BORDER);

      result.artifact1_evidence?.forEach(row => {
        // Dimension · Domain tag (navy pill)
        const tagLabel = `${(row.dimension || '').toUpperCase()}  ·  ${(row.domain || '').toUpperCase()}`;
        const tagW = pdf.setFont('Latin', 'bold') && pdf.setFontSize(7) && pdf.getTextWidth(tagLabel) + 8;
        const tagH = 5.5;
        checkBreak(tagH + 4);
        pdf.setFillColor(...C_NAVY);
        pdf.roundedRect(MARGIN, y, tagW as unknown as number, tagH, 1.5, 1.5, 'F');
        pdf.setTextColor(...C_WHITE);
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(7);
        pdf.text(tagLabel, MARGIN + 4, y + tagH - 1.8);
        y += tagH + 4;

        // Evidence quote
        const evidenceText = `"${row.evidence || ''}"`;
        checkBreak(measureText(evidenceText, 10, 0) + 4);
        addText(evidenceText, 10, 'italic', C_BODY, 0, detectFontFamily(row.evidence), 3);

        // Systemic reasoning label
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(6.5);
        pdf.setTextColor(...C_MUTED);
        checkBreak(5);
        pdf.text('SYSTEMIC REASONING', MARGIN, y);
        y += 5;

        // Reasoning body
        addText(row.reasoning || '', 8.5, 'normal', C_TAG_TEXT, 0, 'Latin', 3);

        hRule([241, 245, 249]);
      });

      addPageFooter();

      // ══════════════════════════════════════════════════════════════════════
      // ARTIFACT 2 — CONTEXT MATRIX
      // ══════════════════════════════════════════════════════════════════════
      pdf.addPage(); pageNum++; totalPages++;
      y = MARGIN;
      pdf.setFillColor(...C_VIOLET);
      pdf.rect(0, 0, pageWidth, 1.5, 'F');

      pdf.setFont('Latin', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(...C_MUTED);
      pdf.text('ARTIFACT 2 — CONTEXT MATRIX', MARGIN, y + 6);
      y += 14;
      hRule(C_BORDER);

      result.artifact2_context?.forEach(row => {
        const tagLabel = `${(row.contextLevel || '').toUpperCase()}  ·  ${(row.domain || '').toUpperCase()}`;
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(7);
        const tagW2 = pdf.getTextWidth(tagLabel) + 8;
        checkBreak(5.5 + 4);
        pdf.setFillColor(...C_NAVY);
        pdf.roundedRect(MARGIN, y, tagW2, 5.5, 1.5, 1.5, 'F');
        pdf.setTextColor(...C_WHITE);
        pdf.text(tagLabel, MARGIN + 4, y + 3.7);
        y += 9;
        addText(row.finding || '', 9.5, 'normal', C_BODY, 0, 'Latin', 3);
        hRule([241, 245, 249]);
      });

      addPageFooter();

      // ══════════════════════════════════════════════════════════════════════
      // ARTIFACT 3 — MECHANISM CHAINS
      // ══════════════════════════════════════════════════════════════════════
      pdf.addPage(); pageNum++; totalPages++;
      y = MARGIN;
      pdf.setFillColor(...C_VIOLET);
      pdf.rect(0, 0, pageWidth, 1.5, 'F');

      pdf.setFont('Latin', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(...C_MUTED);
      pdf.text('ARTIFACT 3 — MECHANISM CHAINS', MARGIN, y + 6);
      y += 14;
      hRule(C_BORDER);

      result.artifact3_chains?.forEach((chain, idx) => {
        const chainLabel = chain?.chain_id || `Chain ${idx + 1}`;
        const pathH = measureText(chain?.pathway || '', 10, 0);
        const impactH = measureText(chain?.impacts || '', 9, 0);
        checkBreak(8 + pathH + 6 + impactH + 14);

        // Chain label
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(8);
        pdf.setTextColor(...C_VIOLET);
        pdf.text(chainLabel.toUpperCase(), MARGIN, y + 5);
        y += 8;

        // Systemic pathway label
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(6.5);
        pdf.setTextColor(...C_MUTED);
        pdf.text('SYSTEMIC PATHWAY', MARGIN, y);
        y += 5;
        addText(chain?.pathway || '', 10, 'normal', C_BODY, 0, detectFontFamily(chain?.pathway || ''), 4);

        // Impact synthesis label
        const impactLabel = 'IMPACT SYNTHESIS';
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(6.5);
        pdf.setTextColor(...C_MUTED);
        pdf.text(impactLabel, MARGIN, y);
        y += 5;

        // Impact pill
        const impactText = chain?.impacts || '';
        const impactLineW = pdf.getTextWidth(impactText);
        if (impactLineW < contentWidth - 10) {
          // Short enough for a pill
          const pillW2 = Math.min(impactLineW + 10, contentWidth);
          const pillH2 = 7;
          pdf.setFillColor(...C_BG_LIGHT);
          pdf.setDrawColor(...C_BORDER);
          pdf.setLineWidth(0.3);
          pdf.roundedRect(MARGIN, y, pillW2, pillH2, 2, 2, 'FD');
          pdf.setFont('Latin', 'bold');
          pdf.setFontSize(8);
          pdf.setTextColor(...C_NAVY);
          pdf.text(impactText, MARGIN + 5, y + 4.8);
          y += pillH2 + 3;
        } else {
          addText(impactText, 8.5, 'bold', C_NAVY, 0, 'Latin', 3);
        }

        hRule([241, 245, 249]);
      });

      addPageFooter();

      // ══════════════════════════════════════════════════════════════════════
      // ARTIFACT 4 — LINK MAP (Systems View)
      // ══════════════════════════════════════════════════════════════════════
      pdf.addPage(); pageNum++; totalPages++;
      y = MARGIN;
      pdf.setFillColor(...C_VIOLET);
      pdf.rect(0, 0, pageWidth, 1.5, 'F');

      pdf.setFont('Latin', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(...C_MUTED);
      pdf.text('ARTIFACT 4 — LINK MAP (SYSTEMS VIEW)', MARGIN, y + 6);
      y += 14;
      hRule(C_BORDER);

      const linkMap = result.artifact4_link_map || '';
      if (linkMap && linkMap.trim() && linkMap !== 'Master Research Database Link Verified') {
        // Render Mermaid source as readable text in the dossier (client-side Mermaid rendering
        // is not available inside jsPDF; we present the diagram definition with instructions).
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(7.5);
        pdf.setTextColor(...C_MUTED);
        pdf.text('SYSTEMS DIAGRAM DEFINITION (Mermaid)', MARGIN, y);
        y += 6;

        // Parse node lines and render them legibly
        const mermaidLines = linkMap.split(/\\n|\n/).map(l => l.trim()).filter(Boolean);
        const diagramCardH = Math.max(30, mermaidLines.length * 5.5 + 10);
        checkBreak(diagramCardH + 4);

        pdf.setFillColor(15, 20, 35);
        pdf.setDrawColor(...C_BORDER);
        pdf.setLineWidth(0.3);
        pdf.roundedRect(MARGIN, y, contentWidth, diagramCardH, 3, 3, 'F');

        let dy = y + 7;
        mermaidLines.forEach(line => {
          if (dy + 5 > y + diagramCardH - 3) return;
          pdf.setFont('Latin', 'normal');
          pdf.setFontSize(7.5);
          pdf.setTextColor(180, 220, 255);
          const displayLine = pdf.splitTextToSize(line, contentWidth - 10)[0] || line;
          pdf.text(displayLine, MARGIN + 5, dy);
          dy += 5.5;
        });
        y += diagramCardH + 5;

        // Relationship narrative below the code block
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(7.5);
        pdf.setTextColor(...C_MUTED);
        checkBreak(8);
        pdf.text('SYSTEMS NARRATIVE', MARGIN, y);
        y += 6;

        // Parse edges from Mermaid syntax to derive a readable narrative
        const edgePattern = /\[([^\]]+)\]\s*--?>?\s*\[([^\]]+)\]/g;
        const narrativeLines: string[] = [];
        let match;
        let tempLinkMap = linkMap;
        while ((match = edgePattern.exec(tempLinkMap)) !== null) {
          narrativeLines.push(`• ${match[1]} → ${match[2]}`);
          if (narrativeLines.length >= 10) break;
        }

        if (narrativeLines.length > 0) {
          narrativeLines.forEach(nl => {
            addText(nl, 9, 'normal', C_BODY, 0, 'Latin', 1.5);
          });
        } else {
          // Fallback: just render the raw text readably
          addText(linkMap.replace(/\\n/g, ' | '), 9, 'normal', C_BODY, 0, 'Latin', 3);
        }
      } else {
        // Fallback when no Mermaid was generated
        pdf.setFont('Latin', 'italic');
        pdf.setFontSize(9);
        pdf.setTextColor(...C_MUTED);
        pdf.text('No link map data was generated for this session.', MARGIN, y + 8);
        y += 18;
      }

      // Hub variables note
      checkBreak(14);
      pdf.setFont('Latin', 'bold');
      pdf.setFontSize(7.5);
      pdf.setTextColor(...C_MUTED);
      pdf.text('NOTE', MARGIN, y);
      y += 5;
      addText(
        'The Link Map represents the systems-level relationships between factors, constraints, interventions, '
        + 'and impacts identified in this session. Hub variables (nodes with the most connections) are the '
        + 'highest-leverage points for intervention. Feedback loops indicate self-reinforcing dynamics that '
        + 'may amplify either empowerment or vulnerability over time.',
        8.5, 'normal', C_TAG_TEXT, 0, 'Latin', 3
      );

      addPageFooter();

      // ══════════════════════════════════════════════════════════════════════
      // ARTIFACT 5 — VULNERABILITY HOTSPOTS
      // ══════════════════════════════════════════════════════════════════════
      pdf.addPage(); pageNum++; totalPages++;
      y = MARGIN;
      pdf.setFillColor(...C_VIOLET);
      pdf.rect(0, 0, pageWidth, 1.5, 'F');

      pdf.setFont('Latin', 'bold');
      pdf.setFontSize(9);
      pdf.setTextColor(...C_MUTED);
      pdf.text('ARTIFACT 5 — VULNERABILITY HOTSPOTS', MARGIN, y + 6);
      y += 14;
      hRule(C_BORDER);

      result.artifact5_hotspots?.forEach((item, idx) => {
        // Hotspot label
        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(7.5);
        pdf.setTextColor(...C_MUTED);
        pdf.text(`VULNERABLE POPULATION`, MARGIN, y);
        y += 5;
        addText(item.vulnerable || '', 10, 'bold', C_NAVY, 0, detectFontFamily(item.vulnerable), 4);

        pdf.setFont('Latin', 'bold');
        pdf.setFontSize(7.5);
        pdf.setTextColor(...C_MUTED);
        checkBreak(5);
        pdf.text('CAUSAL DRIVERS', MARGIN, y);
        y += 5;
        addText(item.drivers || '', 9.5, 'normal', C_BODY, 0, 'Latin', 3);

        hRule([241, 245, 249]);
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
      <div className="flex flex-col md:flex-row justify-between items-center gap-6 bg-white p-6 rounded-[2.5rem] shadow-sm border border-slate-100">
        <div className="flex items-center gap-5">
           <div className="p-4 bg-violet-100 rounded-3xl text-violet-600 shadow-inner">
             <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
             </svg>
           </div>
           <div>
             <h2 className="text-2xl font-black text-slate-900 tracking-tight leading-tight">{originalFileName || 'Research Archive'}</h2>
             <div className="flex items-center gap-3 mt-1">
                <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full"></span>
                <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">High-Fidelity Verbatim Sync Active</p>
             </div>
           </div>
        </div>
        
        <div className="flex items-center gap-4">
          <div className="flex p-1.5 bg-slate-100 rounded-2xl shadow-inner">
             <button 
               onClick={() => setActiveTab('transcript')}
               className={`px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'transcript' ? 'bg-white shadow-md text-slate-900' : 'text-slate-400 hover:text-slate-600'}`}
             >Transcript</button>
             <button 
               onClick={() => setActiveTab('artifacts')}
               className={`px-8 py-3 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${activeTab === 'artifacts' ? 'bg-white shadow-md text-slate-900' : 'text-slate-400 hover:text-slate-600'}`}
             >AWESOME Artifacts</button>
          </div>
          <button 
            onClick={generatePDF} 
            disabled={isExporting}
            className={`p-4 rounded-2xl transition-all shadow-xl active:scale-95 flex items-center gap-2
              ${isExporting ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-slate-900 text-white hover:bg-violet-600 shadow-slate-900/20'}
            `}
          >
             {isExporting ? (
               <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
             ) : (
               <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                 <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
               </svg>
             )}
             <span className="text-[10px] font-black uppercase tracking-widest pr-2">Export Dossier</span>
          </button>
          <button
            onClick={sendByEmail}
            disabled={isSendingEmail}
            title="Email dossier to your registered email"
            className={`p-4 rounded-2xl transition-all shadow-xl active:scale-95 flex items-center gap-2
              ${isSendingEmail ? 'bg-slate-200 text-slate-400 cursor-not-allowed' : 'bg-violet-600 text-white hover:bg-violet-700 shadow-violet-600/20'}
            `}
          >
            {isSendingEmail ? (
              <div className="w-5 h-5 border-2 border-white/30 border-t-white rounded-full animate-spin"></div>
            ) : (
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
              </svg>
            )}
            <span className="text-[10px] font-black uppercase tracking-widest pr-2">Email Dossier</span>
          </button>
        </div>
      </div>
      {emailStatus && (
        <div className={`px-6 py-3 rounded-2xl text-sm font-bold text-center ${emailStatus.startsWith('Failed') ? 'bg-rose-50 text-rose-600 border border-rose-200' : 'bg-emerald-50 text-emerald-700 border border-emerald-200'}`}>
          {emailStatus}
        </div>
      )}

      <div className="bg-white rounded-[4.5rem] shadow-2xl shadow-slate-200/50 border border-slate-100 p-12 md:p-24 overflow-hidden relative min-h-[600px]">
        {audioUrl && (
          <div className="mb-8 p-4 rounded-2xl border border-slate-100 bg-slate-50">
            <p className="text-[10px] font-black uppercase tracking-widest text-slate-400 mb-2">Session Audio</p>
            <audio controls src={audioUrl} className="w-full" />
          </div>
        )}
        {activeTab === 'transcript' ? <TranscriptView result={result} /> : <ArtifactsView result={result} />}
      </div>
    </div>
  );
};