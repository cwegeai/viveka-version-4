import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { clearAuthStorage, getStoredUser } from '../services/authStorage';

// ── Types ─────────────────────────────────────────────────────────────────────
interface DashboardStats {
  total_users: number;
  active_users_today: number;
  total_files_processed: number;
  success_rate_pct: number;
  failure_rate_pct: number;
  total_audio_mins: number;
  total_gemini_input_tokens: number;
  total_gemini_output_tokens: number;
  total_gemini_cost_usd: number;
}

interface UserRow {
  id: string;
  email: string;
  full_name: string;
  role: string;
  affiliation?: string;
  nationality_name?: string;
  created_at?: string;
  total_files: number;
  total_audio_mins: number;
  total_input_tokens: number;
  total_output_tokens: number;
  total_cost_usd: number;
  last_active_at?: string;
  last_login_at?: string;
}

interface ActivityRow {
  id: string;
  user_email?: string;
  created_at: string;
  original_filename?: string;
  file_size_mb?: number;
  audio_duration_mins?: number;
  audio_format?: string;
  processing_status: string;
  processing_duration_secs?: number;
  detected_language?: string;
  num_transcript_turns?: number;
  num_speakers?: number;
  translation_generated?: boolean;
  transliteration_generated?: boolean;
  email_sent?: boolean;
  pdf_dossier_downloaded?: boolean;
  gemini_input_tokens?: number;
  gemini_output_tokens?: number;
  gemini_cost_usd?: number;
  error_message?: string;
}

// ── Small UI helpers ───────────────────────────────────────────────────────────
const Stat: React.FC<{
  label: string;
  value: string | number;
  sub?: string;
  icon: React.ReactNode;
  color: string;
}> = ({ label, value, sub, icon, color }) => (
  <div className={`bg-white p-6 rounded-2xl border border-slate-100 shadow-sm flex items-center gap-5`}>
    <div className={`w-14 h-14 rounded-xl flex items-center justify-center shrink-0 ${color}`}>
      {icon}
    </div>
    <div className="min-w-0">
      <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest truncate">{label}</p>
      <p className="text-3xl font-black text-slate-900 leading-none mt-1">{value}</p>
      {sub && <p className="text-[10px] text-slate-400 font-bold mt-1">{sub}</p>}
    </div>
  </div>
);

const Badge: React.FC<{ ok: boolean }> = ({ ok }) => (
  <span className={`inline-block px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider
    ${ok ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' : 'bg-rose-50 text-rose-600 border border-rose-200'}`}>
    {ok ? 'Yes' : 'No'}
  </span>
);

const fmt = {
  date: (s?: string) => s ? new Date(s).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'2-digit' }) : '—',
  mins: (n?: number) => n ? `${Number(n).toFixed(1)}m` : '—',
  cost: (n?: number) => n ? `$${Number(n).toFixed(4)}` : '$0',
  tokens: (n?: number) => n ? Number(n).toLocaleString() : '0',
  secs: (n?: number) => n ? `${Number(n).toFixed(0)}s` : '—',
};

// ── Main component ─────────────────────────────────────────────────────────────
export const AdminConsole: React.FC = () => {
  const navigate = useNavigate();
  const currentUser = getStoredUser();

  const [stats, setStats]           = useState<DashboardStats | null>(null);
  const [users, setUsers]           = useState<UserRow[]>([]);
  const [activity, setActivity]     = useState<ActivityRow[]>([]);
  const [activeView, setActiveView] = useState<'users' | 'activity'>('users');
  const [search, setSearch]         = useState('');
  const [loading, setLoading]       = useState(true);
  const [exportingCsv, setExportingCsv] = useState(false);
  const [selectedUser, setSelectedUser] = useState<UserRow | null>(null);

  // ── Fetch ──────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [dash, usersData] = await Promise.all([
        api.getDashboardStats().catch(() => null),
        api.getAdminUsers(200, 0).catch(() => ({ users: [] })),
      ]);
      if (dash) setStats(dash);
      setUsers(usersData?.users || []);
    } catch (e) {
      console.error('Admin load failed', e);
    } finally {
      setLoading(false);
    }
  }, []);

  const loadActivity = useCallback(async (userId?: string) => {
    try {
      const data = await api.getAdminActivity(userId, 100, 0);
      setActivity(data?.activity || []);
    } catch (e) {
      console.error('Activity load failed', e);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (activeView === 'activity') loadActivity(selectedUser?.id);
  }, [activeView, selectedUser, loadActivity]);

  // ── CSV export ─────────────────────────────────────────────────────────────
  const exportCsv = async () => {
    setExportingCsv(true);
    try {
      const blob = await api.exportActivityCsv(selectedUser?.id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = selectedUser ? `viveka_${selectedUser.email}_activity.csv` : 'viveka_activity.csv';
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert('Export failed');
    } finally {
      setExportingCsv(false);
    }
  };

  // ── Filtered lists ─────────────────────────────────────────────────────────
  const filteredUsers = users.filter(u =>
    !search ||
    u.full_name?.toLowerCase().includes(search.toLowerCase()) ||
    u.email?.toLowerCase().includes(search.toLowerCase()) ||
    u.affiliation?.toLowerCase().includes(search.toLowerCase())
  );

  const filteredActivity = activity.filter(a =>
    !search ||
    a.user_email?.toLowerCase().includes(search.toLowerCase()) ||
    a.original_filename?.toLowerCase().includes(search.toLowerCase()) ||
    a.detected_language?.toLowerCase().includes(search.toLowerCase())
  );

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-slate-50 font-sans p-6">
      <div className="max-w-[1400px] mx-auto space-y-6">

        {/* Header */}
        <header className="flex flex-col md:flex-row justify-between items-center gap-4 bg-white p-6 rounded-2xl shadow-sm border border-slate-100">
          <div>
            <h1 className="text-2xl font-black text-slate-900 uppercase tracking-tight">Admin Console</h1>
            <p className="text-slate-400 font-bold text-[10px] uppercase tracking-widest mt-0.5">
              Viveka AI · System Overview & User Metrics
            </p>
          </div>
          <div className="flex gap-3 flex-wrap">
            <button onClick={() => navigate('/')}
              className="px-5 py-2.5 bg-white border-2 border-slate-100 text-slate-600 rounded-xl font-bold text-[10px] uppercase tracking-widest hover:border-violet-500 hover:text-violet-600 transition-all">
              User View
            </button>
            <button onClick={exportCsv} disabled={exportingCsv}
              className="px-5 py-2.5 bg-emerald-600 text-white rounded-xl font-bold text-[10px] uppercase tracking-widest hover:bg-emerald-700 transition-all disabled:opacity-50 flex items-center gap-2">
              {exportingCsv
                ? <span className="w-3 h-3 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a2 2 0 002 2h12a2 2 0 002-2v-1m-4-4l-4 4m0 0l-4-4m4 4V4" /></svg>
              }
              Export CSV
            </button>
            <button onClick={() => { api.logout(); clearAuthStorage(); navigate('/login'); }}
              className="px-5 py-2.5 bg-slate-900 text-white rounded-xl font-bold text-[10px] uppercase tracking-widest hover:bg-rose-600 transition-all">
              Logout
            </button>
          </div>
        </header>

        {/* Dashboard Stats */}
        <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-5 gap-4">
          <Stat label="Total Users" value={stats?.total_users ?? '—'}
            icon={<svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0z" /></svg>}
            color="bg-violet-50 text-violet-600" />

          <Stat label="Active Today" value={stats?.active_users_today ?? '—'}
            sub="unique logins (24h)"
            icon={<svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5.121 17.804A9 9 0 1119.07 5.93M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>}
            color="bg-emerald-50 text-emerald-600" />

          <Stat label="Files Processed" value={stats?.total_files_processed ?? '—'}
            sub={`${fmt.mins(stats?.total_audio_mins)} audio`}
            icon={<svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>}
            color="bg-blue-50 text-blue-600" />

          <Stat label="Success Rate" value={`${stats?.success_rate_pct ?? '—'}%`}
            sub={`${stats?.failure_rate_pct ?? '—'}% failed`}
            icon={<svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>}
            color="bg-amber-50 text-amber-600" />

          <Stat label="Gemini Cost" value={fmt.cost(stats?.total_gemini_cost_usd)}
            sub={`${fmt.tokens(stats?.total_gemini_input_tokens)} in · ${fmt.tokens(stats?.total_gemini_output_tokens)} out`}
            icon={<svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1" /></svg>}
            color="bg-rose-50 text-rose-600" />
        </div>

        {/* View switcher + search */}
        <div className="flex flex-col md:flex-row gap-4 items-center">
          <div className="flex p-1.5 bg-slate-100 rounded-xl shadow-inner shrink-0">
            {(['users', 'activity'] as const).map(v => (
              <button key={v} onClick={() => setActiveView(v)}
                className={`px-6 py-2 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all
                  ${activeView === v ? 'bg-white shadow text-slate-900' : 'text-slate-400 hover:text-slate-600'}`}>
                {v === 'users' ? `Users (${users.length})` : `Activity Log`}
              </button>
            ))}
          </div>

          <div className="flex-1 relative">
            <input type="text" placeholder="Search..." value={search}
              onChange={e => setSearch(e.target.value)}
              className="w-full bg-white border border-slate-200 rounded-xl pl-9 pr-4 py-2.5 text-xs font-bold focus:outline-none focus:border-violet-400 transition-all" />
            <svg className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
          </div>

          {selectedUser && activeView === 'activity' && (
            <div className="flex items-center gap-2 bg-violet-50 border border-violet-200 px-4 py-2 rounded-xl">
              <span className="text-violet-700 text-[10px] font-black uppercase tracking-wider">{selectedUser.email}</span>
              <button onClick={() => { setSelectedUser(null); loadActivity(); }}
                className="text-violet-400 hover:text-violet-700 font-black text-sm leading-none">×</button>
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center justify-center py-20">
            <div className="w-8 h-8 border-4 border-violet-200 border-t-violet-600 rounded-full animate-spin" />
          </div>
        ) : activeView === 'users' ? (
          /* ── USERS TABLE ── */
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>
                    {['User', 'Role', 'Affiliation', 'Files', 'Audio', 'Tokens In', 'Tokens Out', 'Cost', 'Last Active', 'Actions'].map(h => (
                      <th key={h} className="px-5 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {filteredUsers.map(user => (
                    <tr key={user.id} className="hover:bg-slate-50/60 transition-colors group">
                      <td className="px-5 py-4">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center text-xs font-black shrink-0">
                            {(user.full_name || 'U').charAt(0).toUpperCase()}
                          </div>
                          <div className="min-w-0">
                            <p className="font-bold text-slate-800 truncate">{user.full_name}</p>
                            <p className="text-[10px] text-slate-400 truncate">{user.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-5 py-4">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider
                          ${user.role === 'admin' ? 'bg-slate-900 text-white' : 'bg-slate-100 text-slate-600'}`}>
                          {user.role}
                        </span>
                      </td>
                      <td className="px-5 py-4 text-slate-500 text-xs font-medium max-w-[160px] truncate">{user.affiliation || '—'}</td>
                      <td className="px-5 py-4 font-black text-slate-900 text-center">{user.total_files ?? 0}</td>
                      <td className="px-5 py-4 text-slate-600 text-xs font-bold">{fmt.mins(user.total_audio_mins)}</td>
                      <td className="px-5 py-4 text-slate-600 text-xs font-mono">{fmt.tokens(user.total_input_tokens)}</td>
                      <td className="px-5 py-4 text-slate-600 text-xs font-mono">{fmt.tokens(user.total_output_tokens)}</td>
                      <td className="px-5 py-4 font-bold text-rose-600 text-xs">{fmt.cost(user.total_cost_usd)}</td>
                      <td className="px-5 py-4 text-slate-400 text-xs">{fmt.date(user.last_active_at || user.last_login_at)}</td>
                      <td className="px-5 py-4">
                        <button
                          onClick={() => { setSelectedUser(user); setActiveView('activity'); }}
                          className="px-3 py-1.5 bg-violet-50 text-violet-600 rounded-lg text-[9px] font-black uppercase tracking-widest hover:bg-violet-600 hover:text-white transition-all">
                          Activity
                        </button>
                      </td>
                    </tr>
                  ))}
                  {filteredUsers.length === 0 && (
                    <tr><td colSpan={10} className="py-16 text-center text-slate-400 text-sm font-bold">No users found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          /* ── ACTIVITY TABLE ── */
          <div className="bg-white rounded-2xl shadow-sm border border-slate-100 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm">
                <thead className="bg-slate-50 border-b border-slate-100">
                  <tr>
                    {['Date', 'User', 'File', 'Format', 'Size', 'Audio', 'Status', 'Duration', 'Language', 'Speakers', 'Turns', 'Translated', 'Translit', 'Email', 'PDF', 'Tokens In', 'Tokens Out', 'Cost'].map(h => (
                      <th key={h} className="px-4 py-4 text-[10px] font-black text-slate-400 uppercase tracking-widest whitespace-nowrap">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-50">
                  {filteredActivity.map(row => (
                    <tr key={row.id} className={`hover:bg-slate-50/60 transition-colors ${row.processing_status === 'failed' ? 'bg-rose-50/30' : ''}`}>
                      <td className="px-4 py-3 text-xs text-slate-400 whitespace-nowrap">{fmt.date(row.created_at)}</td>
                      <td className="px-4 py-3 text-xs text-slate-600 max-w-[140px] truncate font-medium">{row.user_email || '—'}</td>
                      <td className="px-4 py-3 text-xs text-slate-700 max-w-[180px] truncate font-bold" title={row.original_filename}>{row.original_filename || '—'}</td>
                      <td className="px-4 py-3 text-[10px] font-mono text-slate-500 uppercase">{row.audio_format || '—'}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{row.file_size_mb ? `${Number(row.file_size_mb).toFixed(1)}MB` : '—'}</td>
                      <td className="px-4 py-3 text-xs text-slate-500">{fmt.mins(row.audio_duration_mins)}</td>
                      <td className="px-4 py-3">
                        <span className={`px-2 py-0.5 rounded-full text-[9px] font-black uppercase tracking-wider
                          ${row.processing_status === 'success' ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                            : row.processing_status === 'failed' ? 'bg-rose-50 text-rose-700 border border-rose-200'
                            : 'bg-amber-50 text-amber-700 border border-amber-200'}`}
                          title={row.error_message || undefined}>
                          {row.processing_status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-xs text-slate-500">{fmt.secs(row.processing_duration_secs)}</td>
                      <td className="px-4 py-3 text-xs text-slate-600 font-medium">{row.detected_language || '—'}</td>
                      <td className="px-4 py-3 text-xs text-center font-bold text-slate-700">{row.num_speakers ?? '—'}</td>
                      <td className="px-4 py-3 text-xs text-center font-bold text-slate-700">{row.num_transcript_turns ?? '—'}</td>
                      <td className="px-4 py-3"><Badge ok={!!row.translation_generated} /></td>
                      <td className="px-4 py-3"><Badge ok={!!row.transliteration_generated} /></td>
                      <td className="px-4 py-3"><Badge ok={!!row.email_sent} /></td>
                      <td className="px-4 py-3"><Badge ok={!!row.pdf_dossier_downloaded} /></td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-500">{fmt.tokens(row.gemini_input_tokens)}</td>
                      <td className="px-4 py-3 text-xs font-mono text-slate-500">{fmt.tokens(row.gemini_output_tokens)}</td>
                      <td className="px-4 py-3 text-xs font-bold text-rose-600">{fmt.cost(row.gemini_cost_usd)}</td>
                    </tr>
                  ))}
                  {filteredActivity.length === 0 && (
                    <tr><td colSpan={18} className="py-16 text-center text-slate-400 text-sm font-bold">No activity records found</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        )}

        <p className="text-center text-slate-400 text-[10px] font-bold uppercase tracking-widest">
          Logged in as {currentUser?.name} ({currentUser?.email})
        </p>
      </div>
    </div>
  );
};