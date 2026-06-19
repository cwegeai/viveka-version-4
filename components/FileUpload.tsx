import React, { useRef, useState } from 'react';

interface FileUploadProps {
  onFileSelect: (file: File | null) => void; // 🔴 allow null for restart
  isProcessing: boolean;
}

const ALLOWED_EXTENSIONS = [
  'mp3','wav','mpeg','mpg','m4a','mp4',
  'aac','amr','ogg','webm','flac',
  'aiff','aif'
];

export const FileUpload: React.FC<FileUploadProps> = ({ onFileSelect, isProcessing }) => {
  const [isDragging, setIsDragging] = useState(false);
  const [selectedFile, setSelectedFile] = useState<File | null>(null); // ⭐ important
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateAndSelect = (file: File) => {
    const extension = file.name.split('.').pop()?.toLowerCase() || '';
    const isAllowedExt = ALLOWED_EXTENSIONS.includes(extension);
    const isAudioType = file.type.startsWith('audio/') || file.type.startsWith('video/');

    if (!isAudioType && !isAllowedExt) {
      alert("Format Not Supported");
      return;
    }

    setSelectedFile(file);      // ⭐ store locally
    onFileSelect(file);
  };

  const handleRestart = () => {
    setSelectedFile(null);
    onFileSelect(null);         // ⭐ clear parent
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!isProcessing) setIsDragging(true); }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setIsDragging(false);
        if (!isProcessing && e.dataTransfer.files[0]) validateAndSelect(e.dataTransfer.files[0]);
      }}
      className={`relative w-full max-w-2xl mx-auto p-1 bg-white rounded-[3rem]
        ${isDragging ? 'ring-2 ring-violet-500 ring-offset-4' : 'shadow-2xl shadow-slate-200/50'}
      `}
    >
      <div className="m-3 border-4 border-dashed rounded-[2.5rem] p-16">
        <input
          type="file"
          ref={fileInputRef}
          onChange={(e) => e.target.files?.[0] && validateAndSelect(e.target.files[0])}
          accept=".mp3,.wav,.mpeg,.mpg,.m4a,.mp4,.aac,.amr,.ogg,.webm,.flac,.aiff,.aif,audio/*,video/*"
          className="hidden"
          disabled={isProcessing}
        />

        <div className="flex flex-col items-center justify-center space-y-8 text-center">

          <h3 className="text-4xl font-black text-[#1e293b] tracking-tight">
            Upload Session
          </h3>

          {/* SELECT BUTTON */}
          <div
            onClick={() => !isProcessing && fileInputRef.current?.click()}
            className="bg-[#1e293b] text-white px-14 py-5 rounded-2xl font-black text-[10px] uppercase tracking-[0.2em] shadow-2xl hover:bg-violet-600 cursor-pointer"
          >
            Select Research File
          </div>

          {/* ⭐ SHOW FILE NAME */}
          {selectedFile && (
            <p className="text-sm text-slate-500 font-semibold">
              {selectedFile.name}
            </p>
          )}

          {/* ⭐ RESTART BUTTON */}
          {selectedFile && (
            <button
              onClick={handleRestart}
              className="px-6 py-3 rounded-xl border border-rose-300 text-rose-600 hover:bg-rose-50 font-bold"
            >
              Restart
            </button>
          )}

        </div>
      </div>
    </div>
  );
};