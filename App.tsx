

import React, { useState, useRef, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { TranscriptionResult } from './types';
import { FileUpload } from './components/FileUpload';
import { LiveRecorder } from './components/LiveRecorder';
import { TranscriptionCard } from './components/TranscriptionCard';
import { transcribeAudio } from './services/transcriptionService';
import { syncToBackend } from './services/storageService';
import { LoginPage } from './components/LoginPage';
import { AdminConsole } from './components/AdminConsole';
import { UserProfile } from './components/UserProfile';
import { api } from './services/api';
import { TRANSCRIPTION_API_URL } from './services/config';
import {
  clearAuthStorage,
  getAccessToken,
  getStoredUser
} from './services/authStorage';

// Assets
import logo1 from './assets/icons/ammachilabs-logo.png';
import logo2 from './assets/icons/amrita-logo.png';
import logo3 from './assets/icons/cwege_logo_black.png';

const Dashboard: React.FC = () => {
  const [result, setResult] = useState<TranscriptionResult | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | undefined>();
  const [originalFile, setOriginalFile] = useState<File | undefined>();
  const [isProcessing, setIsProcessing] = useState(false);
  const [status, setStatus] = useState('');
  const [progress, setProgress] = useState(0);
  const [fileDuration, setFileDuration] = useState<string>('');
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [activeTab, setActiveTab] = useState<'upload' | 'record'>('upload');
  const sessionRef = useRef(0);
  const activeRequestRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (isProcessing) {
      setElapsedSeconds(0);
      timerRef.current = setInterval(() => setElapsedSeconds(s => s + 1), 1000);
    } else {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    }
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; } };
  }, [isProcessing]);
  const restartSession = () => {sessionRef.current += 1;

  activeRequestRef.current?.abort();
  activeRequestRef.current = null;

  setResult(null);
  setOriginalFile(undefined);
  setAudioUrl(undefined);

  setIsProcessing(false);
  setProgress(0);
  setStatus('');
  setFileDuration('');
  setElapsedSeconds(0);
  setActiveTab('upload');
};
  const navigate = useNavigate();
  const currentUser = getStoredUser();
  const transcriptionBackendUrl = TRANSCRIPTION_API_URL;
  const backendPipelineConfigured = Boolean(transcriptionBackendUrl);

  
  const handleAudioSource = async (file: File) => {
    const currentSession = sessionRef.current;   // ⭐ important
    setIsProcessing(true);
    setOriginalFile(file);
    setStatus('Initializing Verbatim Protocol...');
    setProgress(0);
    
    const audio = new Audio();
    audio.src = URL.createObjectURL(file);
    audio.onloadedmetadata = () => {
      const minutes = Math.floor(audio.duration / 60);
      const seconds = Math.floor(audio.duration % 60);
      setFileDuration(`${minutes}:${seconds.toString().padStart(2, '0')}`);
    };
    
    setAudioUrl(audio.src);
    const requestController = new AbortController();
    activeRequestRef.current = requestController;

    try {
      const transcription = await transcribeAudio(
        file, 
        file.type || "audio/mpeg", 
        (msg, prog) => {
          setStatus(msg);
          if (prog !== undefined) {
            setProgress(current => Math.max(current, prog));
          }
        },
        (partialResult) => {
          if (currentSession !== sessionRef.current) return;
          setResult(partialResult);
        },
        requestController.signal
      );
      
      // ⭐ if user restarted → ignore this result
      if (currentSession !== sessionRef.current) return;
      setResult(transcription);
      await syncToBackend(file, transcription);

    } catch (error: any) {
      if (error?.name === 'AbortError' || currentSession !== sessionRef.current) {
        return;
      }
      console.error(error);
      alert(`Viveka Protocol Error: ${error.message || "Analysis failed."}`);
    } finally {
      if (currentSession !== sessionRef.current) return;
      activeRequestRef.current = null;
      setIsProcessing(false);
      setProgress(100);
    }
  };

  return (
    <div className="min-h-screen bg-[#fbfcfd] text-slate-900 font-sans flex flex-col">
      {/* HEADER: Responsive stacking for Mobile */}
      <header className="w-full max-w-[95rem] mx-auto px-4 md:px-8 py-4 md:py-6 flex flex-col md:flex-row justify-between items-center gap-6 shrink-0">
        <div className="text-center md:text-left">
          <h1 className="text-3xl md:text-4xl font-black tracking-tight text-[#1e293b]">Viveka AI</h1>
          <p className="text-[#64748b] font-bold tracking-[0.15em] text-[10px] md:text-[11px] uppercase">Qualitative Verbatim Specialist</p>
        </div>
        
        <div className="flex flex-col items-center gap-6 md:flex-row md:gap-12">
          <div className="flex items-center gap-4 md:gap-8 justify-center">
            <img src={logo2} alt="Amrita" className="h-10 md:h-16 w-auto object-contain" />
            <img src={logo3} alt="CWEGE" className="h-9 md:h-14 w-auto object-contain" />
            <img src={logo1} alt="Ammachi Labs" className="h-6 md:h-9 w-auto object-contain" />
          </div>
          <div className="flex flex-wrap justify-center gap-2 md:gap-3">
            {currentUser.isAdmin && (
              <button onClick={() => navigate('/admin')} className="px-4 md:px-6 py-2 md:py-3 bg-violet-600 text-white rounded-xl text-[10px] md:text-[11px] font-black uppercase tracking-widest shadow-lg hover:shadow-violet-200 transition-all">
                Switch to Admin
              </button>
            )}
            <button onClick={() => navigate('/my-profile')} className="px-4 md:px-6 py-2 md:py-3 bg-white border border-slate-200 text-slate-600 rounded-xl text-[10px] md:text-[11px] font-black uppercase tracking-widest shadow-sm hover:border-violet-400">
              My Profile
            </button>
            <button 
              onClick={() => {
                api.logout();
                clearAuthStorage();
                navigate('/login');
              }}
              className="px-4 md:px-6 py-2 md:py-3 bg-white border border-slate-200 text-slate-600 rounded-xl text-[10px] md:text-[11px] font-black uppercase tracking-widest hover:text-rose-600 shadow-sm"
            >
              Logout
            </button>
          </div>
        </div>
      </header>

      {/* MAIN CONTAINER */}
      <main className="w-full max-w-6xl mx-auto px-4 md:px-6 flex flex-col pb-8 md:pb-12">
        {!result ? (
          <div className="flex flex-col gap-6 md:gap-8">
            {/* WELCOME HEADER */}
            <div className="text-center">
              <h2 className="text-2xl md:text-4xl font-extrabold text-[#0f172a] mb-2">Welcome to Viveka AI 👋</h2>
              <p className="text-slate-500 max-w-2xl mx-auto text-sm md:text-base">
                High-Fidelity Qualitative Research. Viveka helps you process recordings into transcription, 
                transliteration, translation, and basic analysis — automatically.
              </p>
            </div>

            <div className="bg-white rounded-2xl border border-slate-100 shadow-sm p-4 md:p-5">
              <div className="flex flex-col md:flex-row md:items-center gap-3 md:gap-4">
                <div className="flex-1">
                  <p className="font-bold text-slate-900 text-xs md:text-sm mb-1">Backend Transcription Pipeline</p>
                  <p className="text-slate-500 text-[11px] md:text-xs">Deepgram handles server-side transcription. Gemini generates AWESOME artifacts after chunk merge.</p>
                </div>
                <div className={`px-4 py-3 rounded-xl text-[10px] md:text-[11px] font-black uppercase tracking-widest shadow-sm ${backendPipelineConfigured ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
                  {backendPipelineConfigured ? 'Pipeline Ready' : 'Pipeline Not Configured'}
                </div>
              </div>
            </div>

            {/* BEST PRACTICES CARDS: Stacks on Mobile */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 md:gap-6">
              <div className="bg-white p-4 md:p-5 rounded-2xl border border-slate-100 flex items-start gap-4 shadow-sm">
                <div className="w-10 h-10 md:w-12 md:h-12 bg-slate-50 rounded-xl flex items-center justify-center shrink-0 border border-slate-100 text-lg md:text-xl">⚖️</div>
                <div>
                  <p className="font-bold text-slate-900 text-xs md:text-sm mb-1">File Limit:</p>
                  <p className="text-slate-500 text-[11px] md:text-xs leading-relaxed">Large uploads are accepted through chunked transfer. Backend is designed for long-form chunked processing.</p>
                </div>
              </div>

              <div className="bg-white p-4 md:p-5 rounded-2xl border border-slate-100 flex items-start gap-4 shadow-sm">
                <div className="w-10 h-10 md:w-12 md:h-12 bg-slate-50 rounded-xl flex items-center justify-center shrink-0 border border-slate-100 text-lg md:text-xl">✂️</div>
                <div>
                  <p className="font-bold text-slate-900 text-xs md:text-sm mb-1">For Speed:</p>
                  <p className="text-slate-500 text-[11px] md:text-xs leading-relaxed">The backend normalizes audio, creates 10-minute chunks, and processes them in parallel.</p>
                </div>
              </div>

              <div className="bg-white p-4 md:p-5 rounded-2xl border border-slate-100 flex items-start gap-4 shadow-sm">
                <div className="w-10 h-10 md:w-12 md:h-12 bg-slate-50 rounded-xl flex items-center justify-center shrink-0 border border-slate-100 text-lg md:text-xl">⏸️</div>
                <div>
                  <p className="font-bold text-slate-900 text-xs md:text-sm mb-1">Recording Tip:</p>
                  <p className="text-slate-500 text-[11px] md:text-xs leading-relaxed">Live recordings still work, and longer source files now process directly through the backend transcription pipeline without relying on the Redis worker queue.</p>
                </div>
              </div>
            </div>

            {/* METHOD SELECTION: Stacks on Mobile */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4 md:gap-6">
              <div 
                onClick={() => setActiveTab('upload')}
                className={`cursor-pointer p-5 md:p-6 rounded-[1.5rem] md:rounded-[2rem] border-2 transition-all flex items-center gap-4 md:gap-6 ${activeTab === 'upload' ? 'border-violet-500 bg-white shadow-xl md:scale-[1.02]' : 'border-transparent bg-slate-50/50 hover:bg-white'}`}
              >
                <div className="w-12 h-12 md:w-16 md:h-16 bg-[#0f172a] rounded-xl md:rounded-2xl flex items-center justify-center text-white shrink-0 shadow-lg">
                  <svg className="w-6 h-6 md:w-8 md:h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
                </div>
                <div>
                  <h4 className="text-xl md:text-2xl font-bold text-slate-900 leading-tight">File Upload</h4>
                  <p className="text-slate-400 text-xs md:text-sm mt-1">Submit audio → auto-analyze</p>
                </div>
              </div>

              <div 
                onClick={() => setActiveTab('record')}
                className={`cursor-pointer p-5 md:p-6 rounded-[1.5rem] md:rounded-[2rem] border-2 transition-all flex items-center gap-4 md:gap-6 ${activeTab === 'record' ? 'border-violet-500 bg-white shadow-xl md:scale-[1.02]' : 'border-transparent bg-slate-50/50 hover:bg-white'}`}
              >
                <div className="w-12 h-12 md:w-16 md:h-16 bg-violet-600 rounded-xl md:rounded-2xl flex items-center justify-center text-white shrink-0 shadow-lg">
                  <svg className="w-6 h-6 md:w-8 md:h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
                </div>
                <div>
                  <h4 className="text-xl md:text-2xl font-bold text-slate-900 leading-tight">Live Recording</h4>
                  <p className="text-slate-400 text-xs md:text-sm mt-1">Record in the Live Studio</p>
                </div>
              </div>
            </div>

            {/* BELOW BOX: Responsive minimum height */}
            <div className="min-h-[400px] md:min-h-[550px] bg-white rounded-[2rem] md:rounded-[3rem] border border-slate-100 shadow-2xl shadow-slate-200/50 flex flex-col items-center justify-center overflow-hidden">
                {isProcessing ? (
  <div className="w-full max-w-lg text-center p-6 md:p-12 animate-fade-in">
    
    <h2 className="text-xl md:text-3xl font-black uppercase text-[#1e293b] mb-6 md:mb-8 tracking-tighter">
      {status}
    </h2>

    <div className="w-full h-4 md:h-6 bg-slate-50 rounded-full overflow-hidden border-2 border-slate-100 p-1 md:p-1.5 mb-4 md:mb-6 shadow-inner">
      <div
        className="h-full bg-violet-600 rounded-full transition-all duration-300"
        style={{ width: `${progress}%` }}
      />
    </div>

    <div className="flex items-center justify-center gap-3 mb-4">
      <span className="w-2 h-2 bg-violet-500 rounded-full animate-pulse"></span>
      <p className="text-slate-500 text-sm font-bold font-mono">
        {String(Math.floor(elapsedSeconds / 60)).padStart(2, '0')}:{String(elapsedSeconds % 60).padStart(2, '0')} elapsed
      </p>
    </div>

    <p className="text-slate-400 text-xs md:text-sm italic font-semibold">
      Processing verbatim data...
    </p>

    {/* ⭐ Restart button */}
  <button
  onClick={restartSession}
  className="mt-8 px-8 py-3 rounded-xl border border-rose-300 text-rose-600 font-bold hover:bg-rose-50 transition"
>
  Cancel & Restart
</button>

  </div>
) : (
  <div className="w-full h-full flex items-center justify-center p-4 md:p-10">
<div className="flex flex-col items-center gap-6">
  {activeTab === 'upload' ? (
    <FileUpload onFileSelect={handleAudioSource} isProcessing={isProcessing} />
  ) : (
    <LiveRecorder onRecordingComplete={handleAudioSource} isProcessing={isProcessing} />
  )}

  {/* ⭐ Restart visible once file/recording exists */}
  {(originalFile || audioUrl) && (
    <button
      onClick={restartSession}
      className="px-8 py-3 rounded-xl border border-rose-300 text-rose-600 font-bold hover:bg-rose-50 transition"
    >
      Restart
    </button>
  )}
</div>
                  </div>
                )}
            </div>
          </div>
        ) : (
          <div className="py-2 md:py-4">
            <TranscriptionCard result={result} audioUrl={audioUrl} originalFileName={originalFile?.name} originalFile={originalFile} onRestart={restartSession} />
          </div>
        )}
      </main>

      {/* FOOTER */}
      <footer className="mt-auto py-4 md:py-6 text-center text-slate-400 text-[10px] md:text-[11px] font-black uppercase tracking-widest border-t border-slate-100 bg-white px-4">
        Version 2.0 | High-Fidelity Qualitative Research Protocol
      </footer>
    </div>
  );
};

const ProtectedRoute = ({ children }: { children: React.ReactElement }) => {
  const isAuthenticated = !!getAccessToken();
    return isAuthenticated ? children : <Navigate to="/login" replace />;
};

const AdminRoute = ({ children }: { children: React.ReactElement }) => {
  const isAuthenticated = !!getAccessToken();
  const user = getStoredUser();
  return isAuthenticated && user.isAdmin ? children : <Navigate to="/" replace />;
};

const App: React.FC = () => {
    return (
        <Router>
            <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route path="/admin" element={<AdminRoute><AdminConsole /></AdminRoute>} />
                <Route path="/profile/:userId" element={<ProtectedRoute><UserProfile /></ProtectedRoute>} />
                <Route path="/my-profile" element={<ProtectedRoute><UserProfile /></ProtectedRoute>} />
                <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
            </Routes>
        </Router>
    );
};

export default App;


// import React, { useState, useEffect, useRef } from 'react';
// import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
// import { TranscriptionResult } from './types';
// import { FileUpload } from './components/FileUpload';
// import { LiveRecorder } from './components/LiveRecorder';
// import { TranscriptionCard } from './components/TranscriptionCard';
// import { transcribeAudio } from './services/geminiService';
// import { syncToBackend } from './services/storageService';
// import { LoginPage } from './components/LoginPage';
// import { AdminConsole } from './components/AdminConsole';
// import { UserProfile } from './components/UserProfile';
// import { api } from './services/api';

// // Assets
// import logo1 from './assets/icons/ammachilabs-logo.png';
// import logo2 from './assets/icons/amrita-logo.png';
// import logo3 from './assets/icons/cwege_logo_black.png';

// const Dashboard: React.FC = () => {
//   const [result, setResult] = useState<TranscriptionResult | null>(null);
//   const [audioUrl, setAudioUrl] = useState<string | undefined>();
//   const [originalFile, setOriginalFile] = useState<File | undefined>();
//   const [isProcessing, setIsProcessing] = useState(false);
//   const [status, setStatus] = useState('');
//   const [progress, setProgress] = useState(0);
//   const [fileDuration, setFileDuration] = useState<string>('');
//   const [activeTab, setActiveTab] = useState<'upload' | 'record'>('upload');
  
//   const progressTimerRef = useRef<number | null>(null);
//   const navigate = useNavigate();
//   const currentUser = JSON.parse(localStorage.getItem('viveka_user') || '{}');

//   useEffect(() => {
//     if (isProcessing) {
//       progressTimerRef.current = window.setInterval(() => {
//         setProgress(prev => {
//           if (prev < 20) return prev + 0.8; 
//           if (prev < 40) return prev + 0.3;
//           if (prev < 80) return prev + 0.1;
//           if (prev < 98) return prev + 0.02;
//           return prev;
//         });
//       }, 500);
//     } else {
//       if (progressTimerRef.current) clearInterval(progressTimerRef.current);
//     }
//     return () => { if (progressTimerRef.current) clearInterval(progressTimerRef.current); };
//   }, [isProcessing]);

//   const handleAudioSource = async (file: File) => {
//     setIsProcessing(true);
//     setOriginalFile(file);
//     setStatus('Initializing Verbatim Protocol...');
//     setProgress(0);
    
//     const audio = new Audio();
//     audio.src = URL.createObjectURL(file);
//     audio.onloadedmetadata = () => {
//       const minutes = Math.floor(audio.duration / 60);
//       const seconds = Math.floor(audio.duration % 60);
//       setFileDuration(`${minutes}:${seconds.toString().padStart(2, '0')}`);
//     };
    
//     setAudioUrl(audio.src);

//     try {
//       const transcription = await transcribeAudio(
//         file, 
//         file.type || "audio/mpeg", 
//         (msg, prog) => {
//           setStatus(msg);
//           if (prog !== undefined) {
//             setProgress(current => Math.max(current, prog));
//           }
//         }
//       );
      
//       setResult(transcription);
//       await syncToBackend(file, transcription);
//     } catch (error: any) {
//       console.error(error);
//       alert(`Viveka Protocol Error: ${error.message || "Analysis failed."}`);
//     } finally {
//       setIsProcessing(false);
//       setProgress(100);
//     }
//   };

//   const handleReset = () => {
//     setResult(null);
//     setAudioUrl(undefined);
//     setOriginalFile(undefined);
//     setProgress(0);
//     setStatus('');
//     setFileDuration('');
//   };

//   return (
//     // Changed: Removed overflow-hidden to allow natural scrolling
//     <div className="min-h-screen bg-[#fbfcfd] text-slate-900 font-sans flex flex-col">
//       {/* HEADER: Keeping Large Amrita branding */}
//       <header className="w-full max-w-[95rem] mx-auto px-8 py-6 flex justify-between items-center shrink-0">
//         <div className="text-left">
//           <h1 className="text-4xl font-black tracking-tight text-[#1e293b]">Viveka AI</h1>
//           <p className="text-[#64748b] font-bold tracking-[0.15em] text-[11px] uppercase">Qualitative Verbatim Specialist</p>
//         </div>
        
//         <div className="flex items-center gap-12">
//           <div className="flex items-center gap-8">
//             <img src={logo2} alt="Amrita" className="h-16 w-auto object-contain" />
//             <img src={logo3} alt="CWEGE" className="h-14 w-auto object-contain" />
//             <img src={logo1} alt="Ammachi Labs" className="h-9 w-auto object-contain" />
//           </div>
//           <div className="flex gap-3">
//             {currentUser.isAdmin && (
//               <button onClick={() => navigate('/admin')} className="px-6 py-3 bg-violet-600 text-white rounded-xl text-[11px] font-black uppercase tracking-widest shadow-lg hover:shadow-violet-200 transition-all">
//                 Switch to Admin
//               </button>
//             )}
//             <button onClick={() => navigate('/my-profile')} className="px-6 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl text-[11px] font-black uppercase tracking-widest shadow-sm hover:border-violet-400">
//               My Profile
//             </button>
//             <button 
//               onClick={() => {
//                 api.logout();
//                 localStorage.removeItem('viveka_user');
//                 localStorage.removeItem('access_token');
//                 navigate('/login');
//               }}
//               className="px-6 py-3 bg-white border border-slate-200 text-slate-600 rounded-xl text-[11px] font-black uppercase tracking-widest hover:text-rose-600 shadow-sm"
//             >
//               Logout
//             </button>
//           </div>
//         </div>
//       </header>

//       {/* MAIN CONTAINER */}
//       <main className="w-full max-w-6xl mx-auto px-6 flex flex-col pb-12">
//         {!result ? (
//           <div className="flex flex-col gap-8">
//             {/* WELCOME HEADER */}
//             <div className="text-center">
//               <h2 className="text-4xl font-extrabold text-[#0f172a] mb-2">Welcome to Viveka AI 👋</h2>
//               <p className="text-slate-500 max-w-2xl mx-auto text-base">
//                 High-Fidelity Qualitative Research. Viveka helps you process recordings into transcription, 
//                 transliteration, translation, and basic analysis — automatically.
//               </p>
//             </div>

//             {/* BEST PRACTICES CARDS: Top Position */}
//             <div className="grid grid-cols-3 gap-6">
//               <div className="bg-white p-5 rounded-2xl border border-slate-100 flex items-start gap-4 shadow-sm hover:shadow-md transition-shadow">
//                 <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center shrink-0 border border-slate-100 text-xl">⚖️</div>
//                 <div>
//                   <p className="font-bold text-slate-900 text-sm mb-1">File Limit:</p>
//                   <p className="text-slate-500 text-xs leading-relaxed">Max audio size: 100 MB</p>
//                 </div>
//               </div>

//               <div className="bg-white p-5 rounded-2xl border border-slate-100 flex items-start gap-4 shadow-sm hover:shadow-md transition-shadow">
//                 <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center shrink-0 border border-slate-100 text-xl">✂️</div>
//                 <div>
//                   <p className="font-bold text-slate-900 text-sm mb-1">For Speed:</p>
//                   <p className="text-slate-500 text-xs leading-relaxed">Split long audio into 20-30 MB parts (smaller files finish faster)</p>
//                 </div>
//               </div>

//               <div className="bg-white p-5 rounded-2xl border border-slate-100 flex items-start gap-4 shadow-sm hover:shadow-md transition-shadow">
//                 <div className="w-12 h-12 bg-slate-50 rounded-xl flex items-center justify-center shrink-0 border border-slate-100 text-xl">⏸️</div>
//                 <div>
//                   <p className="font-bold text-slate-900 text-sm mb-1">Live Recording Tip:</p>
//                   <p className="text-slate-500 text-xs leading-relaxed">Keep recordings short and stop at natural breaks. Record multiple parts for long sessions.</p>
//                 </div>
//               </div>
//             </div>

//             {/* METHOD SELECTION */}
//             <div className="grid grid-cols-2 gap-6">
//               <div 
//                 onClick={() => setActiveTab('upload')}
//                 className={`cursor-pointer p-6 rounded-[2rem] border-2 transition-all flex items-center gap-6 ${activeTab === 'upload' ? 'border-violet-500 bg-white shadow-xl scale-[1.02]' : 'border-transparent bg-slate-50/50 hover:bg-white hover:shadow-lg'}`}
//               >
//                 <div className="w-16 h-16 bg-[#0f172a] rounded-2xl flex items-center justify-center text-white shrink-0 shadow-lg">
//                   <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
//                 </div>
//                 <div>
//                   <h4 className="text-2xl font-bold text-slate-900 leading-tight">File Upload</h4>
//                   <p className="text-slate-400 text-sm mt-1">Submit audio → results appear automatically</p>
//                 </div>
//               </div>

//               <div 
//                 onClick={() => setActiveTab('record')}
//                 className={`cursor-pointer p-6 rounded-[2rem] border-2 transition-all flex items-center gap-6 ${activeTab === 'record' ? 'border-violet-500 bg-white shadow-xl scale-[1.02]' : 'border-transparent bg-slate-50/50 hover:bg-white hover:shadow-lg'}`}
//               >
//                 <div className="w-16 h-16 bg-violet-600 rounded-2xl flex items-center justify-center text-white shrink-0 shadow-lg">
//                   <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
//                 </div>
//                 <div>
//                   <h4 className="text-2xl font-bold text-slate-900 leading-tight">Live Recording</h4>
//                   <p className="text-slate-400 text-sm mt-1">Record directly in the Live Studio</p>
//                 </div>
//               </div>
//             </div>

//             {/* BELOW BOX: INCREASED SIZE & PROFESSIONALLY ALIGNED */}
//             <div className="min-h-[550px] bg-white rounded-[3rem] border border-slate-100 shadow-2xl shadow-slate-200/50 flex flex-col items-center justify-center overflow-hidden">
//                 {isProcessing ? (
//                   <div className="w-full max-w-lg text-center p-12 animate-fade-in">
//                     <h2 className="text-3xl font-black uppercase text-[#1e293b] mb-8 tracking-tighter">{status}</h2>
//                     <div className="w-full h-6 bg-slate-50 rounded-full overflow-hidden border-2 border-slate-100 p-1.5 mb-6 shadow-inner">
//                       <div className="h-full bg-violet-600 rounded-full transition-all duration-300 shadow-[0_0_15px_rgba(124,58,237,0.4)]" style={{ width: `${progress}%` }} />
//                     </div>
//                     <p className="text-slate-400 text-sm italic font-semibold">Viveka AI is processing your verbatim data...</p>
//                   </div>
//                 ) : (
//                   <div className="w-full h-full flex items-center justify-center p-10">
//                       <div className="w-full flex justify-center scale-110">
//                           {activeTab === 'upload' ? (
//                             <FileUpload onFileSelect={handleAudioSource} isProcessing={isProcessing} />
//                           ) : (
//                             <LiveRecorder onRecordingComplete={handleAudioSource} isProcessing={isProcessing} />
//                           )}
//                       </div>
//                   </div>
//                 )}
//             </div>
//           </div>
//         ) : (
//           <div className="py-4">
//             <TranscriptionCard result={result} audioUrl={audioUrl} originalFileName={originalFile?.name} originalFile={originalFile} />
//           </div>
//         )}
//       </main>

//       {/* FOOTER */}
//       <footer className="mt-auto py-6 text-center text-slate-400 text-[11px] font-black uppercase tracking-widest border-t border-slate-100 bg-white">
//         Version 2.0 | High-Fidelity Qualitative Research Protocol
//       </footer>
//     </div>
//   );
// };

// // ... Routing logic remains the same ...
// const ProtectedRoute = ({ children }: { children: React.ReactElement }) => {
//     const isAuthenticated = !!localStorage.getItem('access_token');
//     return isAuthenticated ? children : <Navigate to="/login" replace />;
// };

// const App: React.FC = () => {
//     return (
//         <Router>
//             <Routes>
//                 <Route path="/login" element={<LoginPage />} />
//                 <Route path="/admin" element={<ProtectedRoute><AdminConsole /></ProtectedRoute>} />
//                 <Route path="/profile/:userId" element={<ProtectedRoute><UserProfile /></ProtectedRoute>} />
//                 <Route path="/my-profile" element={<ProtectedRoute><UserProfile /></ProtectedRoute>} />
//                 <Route path="/" element={<ProtectedRoute><Dashboard /></ProtectedRoute>} />
//             </Routes>
//         </Router>
//     );
// };

// export default App;
