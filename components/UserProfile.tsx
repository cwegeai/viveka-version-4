import React, { useEffect, useState } from 'react';
import { useParams, useLocation } from 'react-router-dom';
import { api } from '../services/api';
import { getStoredUser } from '../services/authStorage';

interface ActivityRow {
  id: string;
  created_at: string;
  original_filename?: string;
  file_size_mb?: number;
  audio_duration_mins?: number;
  audio_format?: string;
  processing_status: string;
  processing_duration_secs?: number;
  detected_language?: string;
  script_used?: string;
  num_speakers?: number;
  num_transcript_turns?: number;
  translation_generated?: boolean;
  transliteration_generated?: boolean;
  email_sent?: boolean;
  pdf_dossier_downloaded?: boolean;
  gemini_input_tokens?: number;
  gemini_output_tokens?: number;
  gemini_cost_usd?: number;
}

const fmt = {
  date: (s?: string) => s ? new Date(s).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—',
  mins: (n?: number) => n ? `${Number(n).toFixed(1)} min` : '—',
  secs: (n?: number) => n ? `${Number(n).toFixed(0)}s` : '—',
  mb:   (n?: number) => n ? `${Number(n).toFixed(1)} MB` : '—',
  tokens: (n?: number) => n ? Number(n).toLocaleString() : '0',
  cost: (n?: number) => n ? `$${Number(n).toFixed(4)}` : '$0.0000',
};

const Pill: React.FC<{ ok: boolean; label?: string }> = ({ ok, label }) => (
  <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider
    ${ok ? 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-400 border border-emerald-200 dark:border-emerald-800'
         : 'bg-slate-100 dark:bg-slate-800 text-slate-400 dark:text-slate-500 border border-slate-200 dark:border-slate-700'}`}>
    {label ?? (ok ? 'Yes' : 'No')}
  </span>
);

export const UserProfile: React.FC<{ onClose?: () => void }> = ({ onClose }) => {
  const { userId } = useParams();
  const location = useLocation();

  const loggedInUser = getStoredUser();
  const user = (userId && location.state?.user) ? location.state.user : loggedInUser;

  const [activity, setActivity] = useState<ActivityRow[]>([]);
  const [loading, setLoading]   = useState(true);
  const [error, setError]       = useState<string | null>(null);

  // Apply dark mode — needed because this page opens in a new tab
  // and the App.tsx useEffect doesn't run here
  useEffect(() => {
    const stored = localStorage.getItem('viveka-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    if (stored === 'dark' || (!stored && prefersDark)) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        let data: { activity: ActivityRow[] };
        if (userId) {
          // Admin viewing another user's profile
          data = await (api as any).getAdminActivity(userId, 100, 0);
        } else {
          data = await (api as any).getMyActivity(50);
        }
        setActivity(data?.activity || []);
      } catch (e: any) {
        setError('Could not load activity history.');
        setActivity([]);
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [userId]);

  const totalAudioMins  = activity.reduce((s, r) => s + (Number(r.audio_duration_mins) || 0), 0);
  const totalTokensIn   = activity.reduce((s, r) => s + (Number(r.gemini_input_tokens) || 0), 0);
  const totalTokensOut  = activity.reduce((s, r) => s + (Number(r.gemini_output_tokens) || 0), 0);
  const totalCost       = activity.reduce((s, r) => s + (Number(r.gemini_cost_usd) || 0), 0);
  const successCount    = activity.filter(r => r.processing_status === 'success').length;

  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 font-sans p-4 md:p-8 transition-colors">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Back / Close row */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => onClose ? onClose() : window.history.back()}
            className="flex items-center gap-2 text-slate-400 hover:text-slate-900 dark:hover:text-white transition-colors text-xs font-bold uppercase tracking-widest"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back
          </button>
          {onClose && (
            <button onClick={onClose}
              className="w-8 h-8 flex items-center justify-center rounded-full bg-slate-100 dark:bg-slate-800 text-slate-500 dark:text-slate-400 hover:bg-slate-200 dark:hover:bg-slate-700 transition-all"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          )}
        </div>

        {/* User card */}
        <div className="bg-white dark:bg-slate-900 p-6 md:p-10 rounded-[2rem] shadow-xl border border-slate-100 dark:border-slate-800 flex flex-col md:flex-row items-center gap-6 md:gap-8 animate-fade-in">
          <div className="w-24 h-24 md:w-28 md:h-28 bg-slate-900 dark:bg-violet-600 rounded-full flex items-center justify-center text-3xl font-black text-white shadow-2xl shrink-0">
            {(user?.full_name || user?.name || 'U').charAt(0).toUpperCase()}
          </div>
          <div className="text-center md:text-left space-y-2 min-w-0 flex-1">
            <h1 className="text-2xl md:text-3xl font-black text-slate-900 dark:text-white tracking-tight">{user?.full_name || user?.name || 'User'}</h1>
            <p className="text-slate-400 dark:text-slate-500 font-medium text-sm">{user?.email}</p>
            <div className="flex flex-wrap gap-2 justify-center md:justify-start">
              {user?.affiliation && <span className="px-3 py-1 bg-violet-50 dark:bg-violet-900/30 text-violet-600 dark:text-violet-400 rounded-full text-[9px] font-black uppercase tracking-widest border border-violet-100 dark:border-violet-800">{user.affiliation}</span>}
              {user?.nationality && <span className="px-3 py-1 bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 rounded-full text-[9px] font-black uppercase tracking-widest border border-blue-100 dark:border-blue-800">{user.nationality}</span>}
              {user?.isAdmin && <span className="px-3 py-1 bg-slate-100 dark:bg-slate-800 text-slate-600 dark:text-slate-400 rounded-full text-[9px] font-black uppercase tracking-widest">Admin</span>}
            </div>
          </div>
        </div>

        {/* Summary stats */}
        {activity.length > 0 && (
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            {[
              { label: 'Files Processed', value: activity.length },
              { label: 'Audio Processed', value: fmt.mins(totalAudioMins) },
              { label: 'Successful', value: `${successCount}/${activity.length}` },
              { label: 'Tokens Used', value: `${fmt.tokens(totalTokensIn + totalTokensOut)}` },
              { label: 'Total Cost', value: fmt.cost(totalCost) },
            ].map(({ label, value }) => (
              <div key={label} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-4 text-center">
                <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">{label}</p>
                <p className="text-xl font-black text-slate-900 dark:text-white">{value}</p>
              </div>
            ))}
          </div>
        )}

        {/* Activity history */}
        <div className="space-y-3">
          <h2 className="text-lg font-black text-slate-900 dark:text-white uppercase tracking-tight px-1">
            Research History {activity.length > 0 && <span className="text-slate-400 dark:text-slate-600 font-bold">({activity.length})</span>}
          </h2>

          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="w-8 h-8 border-4 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
            </div>
          ) : error ? (
            <div className="p-8 text-center text-rose-500 font-bold bg-white dark:bg-slate-900 rounded-2xl border border-rose-100 dark:border-rose-900">
              {error}
            </div>
          ) : activity.length === 0 ? (
            <div className="p-12 text-center bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800">
              <p className="text-slate-400 font-bold italic">No sessions recorded yet.</p>
              <p className="text-slate-300 dark:text-slate-600 text-xs font-bold mt-1">Process your first audio file to see history here.</p>
            </div>
          ) : (
            <div className="space-y-3">
              {activity.map((row, i) => (
                <div key={row.id} className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 p-5 md:p-6 hover:border-violet-200 dark:hover:border-violet-800 transition-all">
                  {/* Row header */}
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
                    <div className="flex items-center gap-3 min-w-0">
                      <div className="w-9 h-9 bg-violet-50 dark:bg-violet-900/30 rounded-xl flex items-center justify-center text-violet-600 dark:text-violet-400 shrink-0 font-black text-sm">
                        {i + 1}
                      </div>
                      <div className="min-w-0">
                        <p className="font-black text-slate-900 dark:text-white text-sm truncate" title={row.original_filename}>
                          {row.original_filename || 'Untitled session'}
                        </p>
                        <p className="text-[10px] font-bold text-slate-400 dark:text-slate-500 mt-0.5">{fmt.date(row.created_at)}</p>
                      </div>
                    </div>
                    <span className={`shrink-0 px-3 py-1 rounded-full text-[9px] font-black uppercase tracking-widest border
                      ${row.processing_status === 'success'
                        ? 'bg-emerald-50 dark:bg-emerald-900/20 text-emerald-700 dark:text-emerald-400 border-emerald-200 dark:border-emerald-800'
                        : row.processing_status === 'failed'
                        ? 'bg-rose-50 dark:bg-rose-900/20 text-rose-600 dark:text-rose-400 border-rose-200 dark:border-rose-800'
                        : 'bg-amber-50 dark:bg-amber-900/20 text-amber-600 dark:text-amber-400 border-amber-200 dark:border-amber-800'}`}>
                      {row.processing_status}
                    </span>
                  </div>

                  {/* Details grid */}
                  <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-3 text-xs">
                    <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-3">
                      <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Audio</p>
                      <p className="font-bold text-slate-700 dark:text-slate-300">{fmt.mins(row.audio_duration_mins)}</p>
                      <p className="text-[9px] text-slate-400 dark:text-slate-500">{fmt.mb(row.file_size_mb)} · {row.audio_format?.toUpperCase() || '—'}</p>
                    </div>

                    <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-3">
                      <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Processing</p>
                      <p className="font-bold text-slate-700 dark:text-slate-300">{fmt.secs(row.processing_duration_secs)}</p>
                      <p className="text-[9px] text-slate-400 dark:text-slate-500">{row.num_transcript_turns ?? 0} turns · {row.num_speakers ?? 0} speakers</p>
                    </div>

                    <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-3">
                      <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Language</p>
                      <p className="font-bold text-slate-700 dark:text-slate-300">{row.detected_language || '—'}</p>
                      <p className="text-[9px] text-slate-400 dark:text-slate-500">{row.script_used || '—'}</p>
                    </div>

                    <div className="bg-slate-50 dark:bg-slate-800/50 rounded-xl p-3">
                      <p className="text-[9px] font-black text-slate-400 dark:text-slate-500 uppercase tracking-widest mb-1">Gemini Cost</p>
                      <p className="font-bold text-slate-700 dark:text-slate-300">{fmt.cost(row.gemini_cost_usd)}</p>
                      <p className="text-[9px] text-slate-400 dark:text-slate-500">{fmt.tokens(row.gemini_input_tokens)}↑ {fmt.tokens(row.gemini_output_tokens)}↓</p>
                    </div>
                  </div>

                  {/* Feature pills */}
                  <div className="flex flex-wrap gap-2 mt-3">
                    <Pill ok={!!row.translation_generated} label="Translated" />
                    <Pill ok={!!row.transliteration_generated} label="Transliterated" />
                    <Pill ok={!!row.pdf_dossier_downloaded} label="PDF Downloaded" />
                    <Pill ok={!!row.email_sent} label="Emailed" />
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};