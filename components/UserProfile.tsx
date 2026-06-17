import React, { useEffect, useState } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { api } from '../services/api';
import { getStoredUser } from '../services/authStorage';

export const UserProfile: React.FC = () => {
  const navigate = useNavigate();
  const { userId } = useParams();
  const location = useLocation();
  const [files, setFiles] = useState<any[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  // If userId is in params, we are viewing someone else (admin mode). 
  // Otherwise, view logged in user.
  const loggedInUser = getStoredUser();
  
  // Use user from state if available (passed from AdminConsole), otherwise fallback to loggedInUser
  const user = (userId && location.state?.user) ? location.state.user : loggedInUser;

  useEffect(() => {
    const fetchFiles = async () => {
      setError(null);
      try {
        const data = userId ? await api.getUserFiles(userId) : await api.getMyFiles();
        setFiles(data);
      } catch (err) {
        console.error("Failed to fetch files", err);
        setFiles([]);
        if (userId && userId.includes('@')) {
          setError("Backend Error: Cannot fetch files using Email ID. User ID (UUID) is missing.");
        } else {
          setError("Failed to load recordings.");
        }
      }
    };
    fetchFiles();
  }, [userId]);

  const handleDownload = async (fileId: string, fileName: string, minioPath?: string) => {
    try {
      const blob = await api.downloadFile(fileId);
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error("Download failed", error);
      if (minioPath) {
        // Fallback to direct MinIO URL if API fails
        window.open(minioPath, '_blank');
      }
    }
  };

  return (
    <div className="min-h-screen bg-slate-50 font-sans p-4 md:p-8">
      <div className="max-w-4xl mx-auto space-y-6 md:space-y-8">
        <button 
          onClick={() => navigate(-1)}
          className="flex items-center gap-2 text-slate-400 hover:text-slate-900 transition-colors text-xs font-bold uppercase tracking-widest mb-4"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
          Back
        </button>

        <div className="bg-white p-6 md:p-10 rounded-[2rem] md:rounded-[3rem] shadow-xl border border-slate-100 flex flex-col md:flex-row items-center gap-6 md:gap-8 animate-fade-in">
          <div className="w-24 h-24 md:w-32 md:h-32 bg-slate-900 rounded-full flex items-center justify-center text-3xl md:text-4xl font-black text-white shadow-2xl shrink-0">
            {user.full_name?.charAt(0) || user.name?.charAt(0) || 'U'}
          </div>
          <div className="text-center md:text-left space-y-2 min-w-0">
            <h1 className="text-3xl md:text-4xl font-black text-slate-900 tracking-tight truncate">{user.full_name || user.name || 'User'}</h1>
            <div className="flex flex-wrap gap-2 md:gap-3 justify-center md:justify-start">
              <span className="px-3 md:px-4 py-1 bg-violet-50 text-violet-600 rounded-full text-[9px] md:text-[10px] font-black uppercase tracking-widest">{user.affiliation || 'Affiliation not set'}</span>
              <span className="px-3 md:px-4 py-1 bg-blue-50 text-blue-600 rounded-full text-[9px] md:text-[10px] font-black uppercase tracking-widest">{user.nationality || 'Nationality not set'}</span>
              {user.isAdmin && <span className="px-3 md:px-4 py-1 bg-slate-100 text-slate-600 rounded-full text-[9px] md:text-[10px] font-black uppercase tracking-widest">Administrator</span>}
            </div>
            <p className="text-slate-400 font-medium truncate text-sm md:text-base">{user.email}</p>
          </div>
        </div>

        <div className="space-y-4 md:space-y-6">
          <h2 className="text-xl md:text-2xl font-black text-slate-900 uppercase tracking-tight ml-4">Research History</h2>
          
          <div className="grid gap-4">
            {files.length === 0 ? (
              <div className="p-8 md:p-10 text-center text-slate-400 font-bold italic bg-white rounded-[2rem] border border-slate-100">
                {error ? (
                  <span className="text-rose-500">{error}</span>
                ) : (
                  <span>No recordings found.</span>
                )}
              </div>
            ) : (
              files.map((file) => (
                <div key={file._id} className="bg-white p-5 md:p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-md transition-all flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 md:gap-6 group">
                  <div className="flex items-center gap-4 w-full sm:w-auto min-w-0">
                    <div className="w-12 h-12 bg-rose-50 rounded-2xl flex items-center justify-center text-rose-500 shrink-0">
                      <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <h3 className="font-bold text-slate-800 text-sm truncate" title={file.filename}>{file.filename}</h3>
                      <div className="flex gap-3 mt-1">
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{new Date(file.created_at).toLocaleDateString()}</span>
                        <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">•</span>
                        <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">PDF</span>
                      </div>
                    </div>
                  </div>
                  
                  <button 
                    onClick={() => handleDownload(file._id, file.filename, file.minio_path)}
                    className="w-full sm:w-auto px-6 py-3 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-violet-600 transition-all active:scale-95 shadow-lg shadow-slate-900/20 flex items-center justify-center gap-2 shrink-0"
                  >
                    Download PDF
                  </button>
                </div>
              ))
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// import React, { useEffect, useState } from 'react';
// import { useNavigate, useParams, useLocation } from 'react-router-dom';
// import { api } from '../services/api';

// export const UserProfile: React.FC = () => {
//   const navigate = useNavigate();
//   const { userId } = useParams();
//   const location = useLocation();
//   const [files, setFiles] = useState<any[]>([]);
//   const [error, setError] = useState<string | null>(null);
  
//   // If userId is in params, we are viewing someone else (admin mode). 
//   // Otherwise, view logged in user.
//   const loggedInUser = JSON.parse(localStorage.getItem('viveka_user') || '{}');
  
//   // Use user from state if available (passed from AdminConsole), otherwise fallback to loggedInUser
//   const user = (userId && location.state?.user) ? location.state.user : loggedInUser;

//   useEffect(() => {
//     const fetchFiles = async () => {
//       setError(null);
//       try {
//         const data = userId ? await api.getUserFiles(userId) : await api.getMyFiles();
//         setFiles(data);
//       } catch (err) {
//         console.error("Failed to fetch files", err);
//         setFiles([]);
//         if (userId && userId.includes('@')) {
//           setError("Backend Error: Cannot fetch files using Email ID. User ID (UUID) is missing.");
//         } else {
//           setError("Failed to load recordings.");
//         }
//       }
//     };
//     fetchFiles();
//   }, [userId]);

//   const handleDownload = async (fileId: string, fileName: string, minioPath?: string) => {
//     try {
//       const blob = await api.downloadFile(fileId);
//       const url = window.URL.createObjectURL(blob);
//       const a = document.createElement('a');
//       a.href = url;
//       a.download = fileName;
//       document.body.appendChild(a);
//       a.click();
//       window.URL.revokeObjectURL(url);
//       document.body.removeChild(a);
//     } catch (error) {
//       console.error("Download failed", error);
//       if (minioPath) {
//         // Fallback to direct MinIO URL if API fails
//         window.open(minioPath, '_blank');
//       }
//     }
//   };

//   return (
//     <div className="min-h-screen bg-slate-50 font-sans p-4 md:p-8">
//       <div className="max-w-4xl mx-auto space-y-8">
//         <button 
//           onClick={() => navigate(-1)}
//           className="flex items-center gap-2 text-slate-400 hover:text-slate-900 transition-colors text-xs font-bold uppercase tracking-widest mb-4"
//         >
//           <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" /></svg>
//           Back
//         </button>

//         <div className="bg-white p-10 rounded-[3rem] shadow-xl border border-slate-100 flex flex-col md:flex-row items-center gap-8 animate-fade-in">
//           <div className="w-32 h-32 bg-slate-900 rounded-full flex items-center justify-center text-4xl font-black text-white shadow-2xl">
//             {user.full_name?.charAt(0) || user.name?.charAt(0) || 'U'}
//           </div>
//           <div className="text-center md:text-left space-y-2">
//             <h1 className="text-4xl font-black text-slate-900 tracking-tight">{user.full_name || user.name || 'User'}</h1>
//             <div className="flex flex-wrap gap-3 justify-center md:justify-start">
//               <span className="px-4 py-1 bg-violet-50 text-violet-600 rounded-full text-[10px] font-black uppercase tracking-widest">{user.affiliation || 'Member'}</span>
//               <span className="px-4 py-1 bg-blue-50 text-blue-600 rounded-full text-[10px] font-black uppercase tracking-widest">{user.nationality || 'Global'}</span>
//               {user.isAdmin && <span className="px-4 py-1 bg-slate-100 text-slate-600 rounded-full text-[10px] font-black uppercase tracking-widest">Administrator</span>}
//             </div>
//             <p className="text-slate-400 font-medium">{user.email}</p>
//           </div>
//         </div>

//         <div className="space-y-6">
//           <h2 className="text-2xl font-black text-slate-900 uppercase tracking-tight ml-4">Research History</h2>
          
//           <div className="grid gap-4">
//             {files.length === 0 ? (
//               <div className="p-10 text-center text-slate-400 font-bold italic bg-white rounded-[2rem] border border-slate-100">
//                 {error ? (
//                   <span className="text-rose-500">{error}</span>
//                 ) : (
//                   <span>No recordings found.</span>
//                 )}
//               </div>
//             ) : (
//               files.map((file) => (
//                 <div key={file._id} className="bg-white p-6 rounded-[2rem] border border-slate-100 shadow-sm hover:shadow-md transition-all flex items-center justify-between group">
//                   <div className="flex items-center gap-4">
//                     <div className="w-12 h-12 bg-rose-50 rounded-2xl flex items-center justify-center text-rose-500">
//                       <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" /></svg>
//                     </div>
//                     <div>
//                       <h3 className="font-bold text-slate-800 text-sm">{file.filename}</h3>
//                       <div className="flex gap-3 mt-1">
//                         <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">{new Date(file.created_at).toLocaleDateString()}</span>
//                         <span className="text-[10px] font-bold text-slate-300 uppercase tracking-wider">•</span>
//                         <span className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">PDF</span>
//                       </div>
//                     </div>
//                   </div>
                  
//                   <button 
//                     onClick={() => handleDownload(file._id, file.filename, file.minio_path)}
//                     className="w-full sm:w-auto px-6 py-3 bg-slate-900 text-white rounded-xl text-[10px] font-black uppercase tracking-widest hover:bg-violet-600 transition-all active:scale-95 shadow-lg shadow-slate-900/20 flex items-center justify-center gap-2"
//                   >
//                     Download PDF
//                   </button>
//                 </div>
//               ))
//             )}
//           </div>
//         </div>
//       </div>
//     </div>
//   );
// };