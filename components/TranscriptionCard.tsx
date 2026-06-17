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
            await uploadToMinio(new File([blob], fileName, { type: 'application/pdf' }));

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
                  {turn.timestamp}
                </span>
              </div>
            </div>

            <div className="pl-8 space-y-6 border-l-8 border-slate-50 group-hover:border-violet-200 transition-colors">
              <div className="space-y-3">
                 <p className="text-[10px] font-black uppercase tracking-[0.3em] text-slate-400">Original Transcription</p>
                 <div className="text-4xl font-bold text-slate-900 leading-snug indian-script">{s(turn.original)}</div>
              </div>
              
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

export const TranscriptionCard: React.FC<Props> = ({ result, audioUrl, originalFileName, onRestart }) => {
  const [activeTab, setActiveTab] = useState<'transcript' | 'artifacts'>('transcript');
  const [isExporting, setIsExporting] = useState(false);


  const generatePDF = async () => {
    setIsExporting(true);

    const folderPath = "/fonts/";
    const fileCache = new Map();

    try {

      const pdf = new jsPDF({
        orientation: 'p',
        unit: 'mm',
        format: 'a4'
      });

      const neededFonts = new Set<string>(['Latin']);
      result.turns.forEach((turn) => {
        neededFonts.add(detectFontFamily(turn.original));
        neededFonts.add(detectFontFamily(turn.transliterated));
        neededFonts.add(detectFontFamily(turn.translated));
      });

      const loadPromises = FONT_LIST.filter((font) => neededFonts.has(font.name)).map(async (font) => {
        let fontBase64;

        if (fileCache.has(font.file)) {
          fontBase64 = fileCache.get(font.file);
        } else {
          const response = await fetch(`${folderPath}${font.file}`);
          if (!response.ok) throw new Error(`Failed to fetch ${font.file}`);
          const buffer = await response.arrayBuffer();
          fontBase64 = arrayBufferToBase64(buffer);
          fileCache.set(font.file, fontBase64);
        }
        pdf.addFileToVFS(font.file, fontBase64);
        pdf.addFont(font.file, font.name, font.style);
      });

    await Promise.all(loadPromises);

      const margin = 20;
      const pageWidth = pdf.internal.pageSize.getWidth();
      const contentWidth = pageWidth - (margin * 2);
      const pageHeight = pdf.internal.pageSize.getHeight();
      let y = 25;

      const checkPageBreak = (needed: number) => {
        if (y + needed > pageHeight - 20) {
          pdf.addPage();
          y = 20;
        }
      };

      const addWrappedText = (
        text: string,
        fontSize: number,
        style: string = 'normal',
        color: [number, number, number] = [30, 41, 59],
        indent: number = 0,
        fontName: string = 'Latin'
      ) => {
        pdf.setFontSize(fontSize);
        pdf.setFont(fontName, style);
        pdf.setTextColor(color[0], color[1], color[2]);
        
        const lines: string[] = pdf.splitTextToSize(text, contentWidth - indent);
        const lineHeight = fontSize * 0.5; // Approximate line height in mm
        
        lines.forEach(line => {
          checkPageBreak(lineHeight);
          pdf.text(line, margin + indent, y);
          y += lineHeight;
        });
        y += 2; // Paragraph spacing
      };

      // 1. Header
      pdf.setFillColor(15, 23, 42);
      pdf.rect(margin, y, contentWidth, 15, 'F');
      pdf.setTextColor(255, 255, 255);
      pdf.setFontSize(14);
      pdf.setFont('Latin', 'bold');
      pdf.text("VIVEKA RESEARCH DOSSIER - VERBATIM SYNTHESIS", margin + 5, y + 10);
      y += 25;

      // 2. Metadata Block
      pdf.setTextColor(100, 116, 139);
      pdf.setFontSize(8);
      pdf.text(`FILE: ${originalFileName || "Session_Archive"}`, margin, y);
      pdf.text(`SYNCED: ${new Date().toLocaleString()}`, margin, y + 4);
      y += 15;

      // 3. Executive Synthesis
      addWrappedText("EXECUTIVE SYNTHESIS", 12, 'bold', [15, 23, 42]);
      pdf.setDrawColor(15, 23, 42);
      pdf.setLineWidth(1);
      pdf.line(margin, y, margin + 40, y);
      y += 8;

      result.executiveSynthesis?.forEach(chunk => {
        addWrappedText(`[Chunk ${chunk.chunk_id}] ${chunk.text}`, 10, 'normal', [71, 85, 105]);
        y += 4;
      });

      y += 10;

      // 4. Verbatim Record
      checkPageBreak(20);
      addWrappedText("VERBATIM RECORD", 12, 'bold', [15, 23, 42]);
      pdf.line(margin, y, margin + 40, y);
      y += 8;

      result.turns?.forEach((turn, i) => {
        checkPageBreak(30);
        // Speaker Header
        pdf.setFillColor(248, 250, 252);
        pdf.rect(margin, y, contentWidth, 10, 'F');
        pdf.setTextColor(15, 23, 42);
        pdf.setFontSize(9);
        pdf.setFont('Latin', 'bold');
        pdf.text(`${turn.speaker.toUpperCase()} - MU ${turn.mu_id}`, margin + 3, y + 6.5);
        pdf.setTextColor(100, 116, 139);
        pdf.setFontSize(8);
        pdf.text(turn.timestamp, pageWidth - margin - 20, y + 6.5);
        y += 15;

        addWrappedText(`Original: ${turn.original}`, 10, 'normal', [15, 23, 42], 5, detectFontFamily(turn.original));

        if (turn.transliterated) {
          pdf.setTextColor(203, 213, 225);
          pdf.setFontSize(7);
          pdf.text("TRANSLITERATION RECORD:", margin + 5, y);
          y += 4;
          addWrappedText(turn.transliterated, 8, 'normal', [148, 163, 184], 5, detectFontFamily(turn.transliterated));
        }
        // Transcript Content (Prioritizing English translation for text-readability)
        pdf.setTextColor(148, 163, 184);
        pdf.setFontSize(7);
        pdf.text("ENGLISH ANALYSIS TIER:", margin + 5, y);
        y += 4;
        addWrappedText(turn.translated, 10, 'italic', [51, 65, 85], 5, detectFontFamily(turn.translated));
        
        // Note: For native script fidelity (Malayalam/Hindi), we recommend the visual viewer
        // as PDF standard fonts require embedding for Unicode ranges.
        y += 8;
      });

      // 5. Artifacts Sections
      pdf.addPage();
      y = 20;
      addWrappedText("QUALITATIVE MAPPING ARTIFACTS", 14, 'bold', [15, 23, 42]);
      y += 10;

      // Artifact 1: Evidence Matrix
      addWrappedText("ARTIFACT 1: EVIDENCE MATRIX", 11, 'bold', [124, 58, 237]);
      result.artifact1_evidence?.forEach(row => {
        checkPageBreak(40);
        pdf.setDrawColor(241, 245, 249);
        //pdf.rect(margin, y, contentWidth, 35);
        y += 5;
        pdf.setFontSize(8);
        pdf.setTextColor(124, 58, 237);
        pdf.text(`${row.dimension} | ${row.domain}`, margin + 5, y);
        y += 6;
        addWrappedText(`Evidence: "${row.evidence}"`, 9, 'italic', [30, 41, 59], 5, detectFontFamily(row.evidence));
        addWrappedText(`Reasoning: ${row.reasoning}`, 8, 'normal', [100, 116, 139], 5, detectFontFamily(row.reasoning));
        y += 5;
      });

      y += 20;
      addWrappedText("ARTIFACT 2: CONTEXT MATRIX", 12, 'bold', [15, 23, 42]);
      y += 5;
      result.artifact2_context?.forEach(row => {
        checkPageBreak(25);
        pdf.setDrawColor(226, 232, 240);
        //pdf.rect(margin, y, contentWidth, 20);
        pdf.setFontSize(9);
        pdf.text(`${row.contextLevel} | ${row.domain}`, margin + 5, y + 7);
        addWrappedText(row.finding, 9, 'normal', [71, 85, 105], 5, detectFontFamily(row.finding));
        y += 5;
      });

      // Artifact 3: Mechanism Chains
      y += 10;
      addWrappedText("ARTIFACT 3: MECHANISM CHAINS", 11, 'bold', [124, 58, 237]);
      result.artifact3_chains?.forEach(chain => {
        checkPageBreak(30);
        pdf.setFillColor(15, 23, 42);
        //pdf.rect(margin, y, 15, 15, 'F');
        pdf.setTextColor(255, 255, 255);
        pdf.setFontSize(10);
        pdf.text(chain?.chain_id || ''  , margin + 5, y + 10);
        
        pdf.setTextColor(15, 23, 42);
        addWrappedText(chain?.pathway, 10, 'bold', [15, 23, 42], 20, detectFontFamily(chain?.pathway || ''));
        addWrappedText(chain?.impacts, 9, 'italic', [100, 116, 139], 20, detectFontFamily(chain?.impacts || ''));
        y += 10;
      });

      y += 10;
      addWrappedText("ARTIFACT 5: VULNERABILITY HOTSPOTS", 12, 'bold', [225, 29, 72]);
      result.artifact5_hotspots?.forEach(item => {
        checkPageBreak(30);
        pdf.setDrawColor(254, 226, 226);
        pdf.setFillColor(255, 251, 251);
        //pdf.rect(margin, y, contentWidth, 25, 'FD');
        addWrappedText(item.vulnerable, 10, 'bold', [15, 23, 42], 5, detectFontFamily(item.vulnerable));
        addWrappedText(`Drivers: ${item.drivers}`, 9, 'normal', [153, 27, 27], 5, detectFontFamily(item.drivers));
        y += 5;
      });

      // Footer Sync
      pdf.setFontSize(7);
      pdf.setTextColor(203, 213, 225);
      pdf.text("Viveka Master Database Sync v8.0 | AWESOME Qual Mapping", pageWidth / 2, pageHeight - 10, { align: 'center' });

      const fileName = `Viveka_Dossier_${Date.now()}.pdf`;
      pdf.save(fileName);
      
      const blob = pdf.output('blob');
      await uploadToMinio(new File([blob], fileName, { type: 'application/pdf' }));
      
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
        </div>
      </div>

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

