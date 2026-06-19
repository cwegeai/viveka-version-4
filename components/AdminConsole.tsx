
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { clearAuthStorage, getStoredUser } from '../services/authStorage';
import { FILE_HISTORY_ENABLED } from '../services/config';

export const AdminConsole: React.FC = () => {
  const navigate = useNavigate();
  const [stats, setStats] = useState<any>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const currentUser = getStoredUser();

  useEffect(() => {
    const fetchStats = async () => {
      if (!FILE_HISTORY_ENABLED) {
        setStats({ total_users: 0, total_files: 0, user_stats: [] });
        return;
      }

      try {
        const data = await api.getDashboardStats();
        console.log("data:", data);
        setStats(data);
      } catch (error) {
        console.error("Failed to fetch dashboard stats", error);
      }
    };
    fetchStats();
  }, []);

  // The user_stats array is used as the source for the user table.
  const sourceUsers = Array.isArray(stats?.user_stats) ? stats.user_stats : [];

  const filteredUsers = sourceUsers.filter((user: any) => {
    const term = searchTerm.toLowerCase();
    return (
      (user.full_name || '').toLowerCase().includes(term) ||
      (user.email || '').toLowerCase().includes(term)
    );
  });

  const users = filteredUsers.map((user: any) => {
    return { 
      ...user, 
      id: user.id || user._id,
      file_count: user.file_count || 0
    };
  });

  const isTruncated = stats?.total_users > sourceUsers.length && !searchTerm;

  return (
    <div className="min-h-screen bg-slate-50 font-sans p-8">
      <div className="max-w-7xl mx-auto space-y-8">
        <header className="flex flex-col md:flex-row justify-between items-center gap-6 bg-white p-8 rounded-[2.5rem] shadow-sm border border-slate-100">
          <div>
            <h1 className="text-3xl font-black text-slate-900 uppercase tracking-tight">Admin Console</h1>
            <p className="text-slate-400 font-bold text-xs uppercase tracking-widest mt-1">System Overview & User Management</p>
          </div>

          <div className="w-full md:w-96 relative">
            <input 
              type="text" 
              placeholder="Search users by name or email..." 
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full bg-slate-50 border border-slate-200 rounded-xl pl-10 pr-4 py-3 text-xs font-bold focus:outline-none focus:border-violet-500 transition-all"
            />
            <svg className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
          </div>

          <div className="flex gap-4">
             <button 
              onClick={() => navigate('/')}
              className="px-6 py-3 bg-white border-2 border-slate-100 text-slate-600 rounded-xl font-bold text-xs uppercase tracking-widest hover:border-violet-500 hover:text-violet-600 transition-all"
            >
              Switch to User View
            </button>
            <button 
              onClick={() => {
                api.logout();
                clearAuthStorage();
                navigate('/login');
              }}
              className="px-6 py-3 bg-slate-900 text-white rounded-xl font-bold text-xs uppercase tracking-widest hover:bg-rose-600 transition-all"
            >
              Logout
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
          {/* Active Users Card */}
          <div className="bg-white p-8 rounded-[2rem] shadow-xl shadow-slate-200/50 border border-slate-100 flex items-center gap-6">
            <div className="w-16 h-16 bg-green-50 rounded-2xl flex items-center justify-center text-green-600">
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
            </div>
            <div>
              <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest">Signed Users</p>
              <p className="text-4xl font-black text-slate-900">{stats?.total_users || 0}</p>
            </div>
          </div>

          {/* Total Recordings Card */}
          <div className="bg-white p-8 rounded-[2rem] shadow-xl shadow-slate-200/50 border border-slate-100 flex items-center gap-6">
            <div className="w-16 h-16 bg-violet-50 rounded-2xl flex items-center justify-center text-violet-600">
              <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" /></svg>
            </div>
            <div>
              <p className="text-slate-400 text-[10px] font-black uppercase tracking-widest">Total Recordings</p>
              <p className="text-4xl font-black text-slate-900">{stats?.total_files || 0}</p>
            </div>
          </div>
        </div>

        {!FILE_HISTORY_ENABLED && (
          <div className="bg-amber-50 border border-amber-200 text-amber-700 rounded-2xl px-6 py-4 text-sm font-semibold">
            Recording history and admin file metrics are disabled in this deployment.
          </div>
        )}

        {isTruncated && (
          <div className="bg-amber-50 border border-amber-200 text-amber-700 rounded-2xl px-6 py-4 text-sm font-semibold">
            Showing partial user list from backend response. Refine search or check backend pagination settings.
          </div>
        )}

        <div className="bg-white rounded-[2.5rem] shadow-xl border border-slate-100 overflow-hidden">
          <div className="overflow-x-auto overflow-y-auto max-h-[75vh]">
            <table className="w-full text-left">
              <thead className="bg-slate-50 border-b border-slate-100">
                <tr>
                  <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Name</th>
                  <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Email ID</th>
                  <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Affiliation</th>
                  <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest">Nationality</th>
                  <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-center">Recordings</th>
                  <th className="p-6 text-[10px] font-black text-slate-400 uppercase tracking-widest text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-50">
                {users.map((user: any) => (
                  <tr key={user.id || user.email} className="hover:bg-slate-50/50 transition-colors group">
                    <td className="p-6 font-bold text-slate-700 flex items-center gap-3">
                      <div className="w-8 h-8 rounded-full bg-violet-100 text-violet-600 flex items-center justify-center text-xs font-black">
                        {user.full_name?.charAt(0) || 'U'}
                      </div>
                      {user.full_name}
                      {user.roles?.includes('admin') && <span className="px-2 py-0.5 bg-slate-900 text-white text-[8px] rounded-md uppercase tracking-wider">Admin</span>}
                    </td>
                    <td className="p-6 font-medium text-slate-500 text-sm">{user.email}</td>
                    <td className="p-6 font-bold text-slate-600 text-xs uppercase tracking-wide">{user.affiliation}</td>
                    <td className="p-6 font-medium text-slate-600 text-sm">{user.nationality_name}</td>
                    <td className="p-6 font-black text-slate-900 text-center">{user.file_count}</td>
                    <td className="p-6 text-right">
                      {user.id ? (
                        <button 
                          onClick={() => navigate(`/profile/${user.id}`, { state: { user } })}
                          className="px-4 py-2 bg-violet-50 text-violet-600 rounded-lg text-[10px] font-black uppercase tracking-widest hover:bg-violet-600 hover:text-white transition-all"
                        >
                          View Profile
                        </button>
                      ) : (
                        <span className="text-[10px] text-slate-300 font-bold uppercase tracking-widest cursor-not-allowed" title="User ID missing from backend data">
                          No ID
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        
        <div className="text-center">
           <p className="text-slate-400 text-[10px] font-bold uppercase tracking-widest">
             Logged in as: {currentUser.name} ({currentUser.email})
           </p>
        </div>
      </div>
    </div>
  );
};