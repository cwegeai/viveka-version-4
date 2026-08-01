
import React, { useState, useRef, useEffect } from 'react';

interface LiveRecorderProps {
  onRecordingComplete: (file: File) => void;
  isProcessing: boolean;
}

export const LiveRecorder: React.FC<LiveRecorderProps> = ({ onRecordingComplete, isProcessing }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const timerRef = useRef<number | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const isDiscardingRef = useRef(false);

  useEffect(() => {
    return () => {
      if (timerRef.current) window.clearInterval(timerRef.current);
    };
  }, []);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
  if (isDiscardingRef.current) {
    chunksRef.current = [];
    isDiscardingRef.current = false;
    stream.getTracks().forEach(track => track.stop());
    return;
  }

  const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
  const file = new File([audioBlob], `recording_${Date.now()}.webm`, { type: 'audio/webm' });
  onRecordingComplete(file);
  stream.getTracks().forEach(track => track.stop());
};

      recorder.start();
      setIsRecording(true);
      setDuration(0);
      timerRef.current = window.setInterval(() => {
        setDuration(prev => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Microphone access denied:", err);
      alert("Microphone access is required for live recording.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      if (timerRef.current) window.clearInterval(timerRef.current);
    }
  };

  const discardRecording = () => {
  if (mediaRecorderRef.current && isRecording) {
    isDiscardingRef.current = true;
    mediaRecorderRef.current.stop();
    setIsRecording(false);
    setDuration(0);
    chunksRef.current = [];
    if (timerRef.current) window.clearInterval(timerRef.current);
  }
};

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="w-full max-w-2xl mx-auto p-1 bg-white dark:bg-slate-900 rounded-[3.5rem] transition-all duration-500 overflow-hidden shadow-2xl dark:bg-slate-none">
      <div className="m-2 bg-white dark:bg-slate-900 rounded-[3rem] p-12 sm:p-16 flex flex-col items-center justify-center space-y-10">
        <div className="flex flex-col items-center space-y-2">
          {isRecording ? (
            <div className="flex items-center gap-3 px-6 py-2 bg-rose-50 border border-rose-100 rounded-full">
              <span className="w-3 h-3 bg-rose-500 rounded-full animate-pulse shadow-[0_0_12px_rgba(244,63,94,0.6)]"></span>
              <span className="text-[10px] font-black text-rose-600 uppercase tracking-[0.3em]">Recording Active</span>
            </div>
          ) : (
            <div className="flex items-center gap-3 px-6 py-2 bg-slate-50 dark:bg-slate-800 border border-slate-100 dark:border-slate-700 rounded-full">
              <span className="w-3 h-3 bg-slate-300 dark:bg-slate-600 rounded-full"></span>
              <span className="text-[10px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-[0.3em]">Studio Ready</span>
            </div>
          )}
        </div>

        <div className="text-7xl sm:text-8xl font-black text-slate-900 dark:text-white tracking-tighter tabular-nums">
          {formatTime(duration)}
        </div>

        <div className="relative group">
          {!isRecording ? (
            <button
              onClick={startRecording}
              disabled={isProcessing}
              className={`w-32 h-32 rounded-[3rem] flex items-center justify-center transition-all duration-500 shadow-2xl
                ${isProcessing ? 'bg-slate-100 text-slate-300 cursor-not-allowed' : 'bg-violet-600 text-white hover:bg-violet-700 hover:scale-110 active:scale-95 shadow-violet-500/30'}
              `}
            >
              <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="6" />
                <path fillRule="evenodd" d="M12 2C6.477 2 2 6.477 2 12s4.477 10 10 10 10-4.477 10-10S17.523 2 12 2zM4 12a8 8 0 1116 0 8 8 0 01-16 0z" clipRule="evenodd" />
              </svg>
            </button>
          ) : (
            <button
              onClick={stopRecording}
              className="w-32 h-32 bg-slate-900 dark:bg-slate-100 text-white dark:text-slate-900 rounded-[3rem] flex items-center justify-center transition-all duration-500 hover:bg-rose-600 dark:hover:bg-rose-500 dark:hover:text-white hover:scale-110 active:scale-95 shadow-2xl shadow-slate-900/30"
            >
              <svg className="w-12 h-12" fill="currentColor" viewBox="0 0 24 24">
                <rect x="7" y="7" width="10" height="10" rx="2" />
              </svg>
            </button>
          )}
          
          <div className="absolute -bottom-10 left-1/2 -translate-x-1/2 w-max">
             <span className="text-[10px] font-black uppercase tracking-[0.2em] text-slate-400 dark:text-slate-500">
               {isRecording ? "Stop & Transcribe" : "Start Live Session"}
             </span>
          </div>
        </div>
        {isRecording && (
  <button
    onClick={discardRecording}
    className="mt-4 px-6 py-3 rounded-xl border border-rose-200 dark:border-rose-800 bg-rose-50 dark:bg-rose-900/20 text-rose-600 font-bold text-sm dark:text-rose-400 hover:bg-rose-100 dark:hover:bg-rose-900/40 transition shadow-sm"
  >
    Discard Recording
  </button>
)}

        <p className="text-slate-500 dark:text-slate-400 font-bold text-sm text-center pt-8 max-w-xs leading-relaxed">
          Record your ideas, interviews, or voice notes directly. We'll handle the rest.
        </p>
      </div>
    </div>
  );
};
