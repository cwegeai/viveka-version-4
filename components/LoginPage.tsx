import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../services/api';
import { COUNTRIES, flagToCountryCode } from '../constants/countries';
import {
  cacheRegistrationProfile,
  clearCachedRegistrationProfile,
  getCachedRegistrationProfile,
  setAccessToken,
  setStoredUser
} from '../services/authStorage';

import logo1 from '../assets/icons/ammachilabs-logo.png'; // NOTE: Update with your actual logo file names
import logo2 from '../assets/icons/amrita-logo.png'; // NOTE: Update with your actual logo file names
import logo3 from '../assets/icons/cwege_logo_black.png'; // NOTE: Update with your actual logo file names

export const LoginPage: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [name, setName] = useState('');
  const [affiliation, setAffiliation] = useState('Academic');
  const [nationality, setNationality] = useState('India');
  const [isCountryOpen, setIsCountryOpen] = useState(false);
  const [countrySearch, setCountrySearch] = useState('');
  const [isRegistering, setIsRegistering] = useState(false);
  const [showSuccess, setShowSuccess] = useState(false);
  const navigate = useNavigate();

  const filteredCountries = COUNTRIES.filter(c => 
    c.name.toLowerCase().includes(countrySearch.toLowerCase())
  );

  const getNationalityCode = (countryName: string): string => {
    const country = COUNTRIES.find((item) => item.name === countryName);
    return country ? flagToCountryCode(country.flag) : "ZZ";
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isRegistering) {
      if (email && password && name && confirmPassword) {
        if (password !== confirmPassword) {
          alert("Passwords do not match. Please try again.");
          return;
        }
        try {
          const code = getNationalityCode(nationality);
          
          await api.register({
            full_name: name,
            email,
            password,
            nationality_code: code,
            nationality_name: nationality,
            affiliation
          });
          cacheRegistrationProfile({
            email,
            full_name: name,
            affiliation,
            nationality
          });
          setShowSuccess(true);
        } catch (error: any) {
          console.error("Registration Error:", error);
          // Display specific error message from backend if available, or fallback to network error message
          const message = error.response?.data?.message || error.message || "Registration failed. Please try again.";
          alert(message);
        }
      } else {
        alert("Please fill in all fields to register.");
      }
    } else {
      try {
        const data = await api.login({ username: email, password });
        const roles = Array.isArray(data.roles) ? data.roles : [];
        const cachedProfile = getCachedRegistrationProfile();
        const useCachedProfile = cachedProfile.email === email;
        
        setAccessToken(data.access_token);
        
        const userObj = {
          name: data.full_name || data.name || email.split('@')[0], 
          full_name: data.full_name || data.name || email.split('@')[0],
          email: email,
          isAdmin: roles.includes('admin'),
          roles,
          affiliation: data.affiliation || (useCachedProfile ? cachedProfile.affiliation : undefined),
          nationality: data.nationality_name || data.nationality || (useCachedProfile ? cachedProfile.nationality : undefined)
        };
        
        setStoredUser(userObj);
        if (useCachedProfile) clearCachedRegistrationProfile();
        
        if (userObj.isAdmin) {
          navigate('/admin');
        } else {
          navigate('/');
        }
      } catch (error: any) {
        console.error("Login Error:", error);
        const message = error.response?.data?.message || "Invalid credentials or network error.";
        alert(message);
      }
    }
  };

  const handleSuccessDismiss = () => {
    setShowSuccess(false);
    setIsRegistering(false);
    setEmail('');
    setPassword('');
    setConfirmPassword('');
    setName('');
  };

  if (showSuccess) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans relative overflow-hidden">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-violet-200/30 rounded-full blur-3xl animate-pulse"></div>
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-200/30 rounded-full blur-3xl animate-pulse delay-1000"></div>
        
        <div className="bg-white/80 backdrop-blur-xl p-12 rounded-[2.5rem] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.1)] w-full max-w-md border border-white/50 relative z-10 animate-fade-in text-center">
          <div className="w-24 h-24 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-8 shadow-inner">
            <svg className="w-12 h-12 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-3xl font-black text-slate-800 mb-3 tracking-tight">Welcome Aboard!</h2>
          <p className="text-slate-500 mb-10 font-medium">Your account has been successfully created.</p>
          <button 
            onClick={handleSuccessDismiss}
            className="w-full bg-slate-900 text-white py-4 rounded-xl font-bold text-sm shadow-lg hover:bg-violet-600 hover:shadow-violet-500/30 transition-all transform hover:-translate-y-1 active:scale-95"
          >
            Proceed to Login
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center p-4 font-sans relative overflow-hidden">
      <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-violet-200/30 rounded-full blur-3xl animate-pulse"></div>
      <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-200/30 rounded-full blur-3xl animate-pulse delay-1000"></div>

      <div className="bg-white/80 backdrop-blur-xl p-8 md:p-10 rounded-[2.5rem] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.1)] w-full max-w-[28rem] border border-white/50 relative z-10 animate-fade-in">
        <div className="text-center mb-8">
          {/* LOGO SECTION UPDATED */}
          <div className="flex justify-center items-center gap-4 mx-auto w-full px-4 mb-4">
            <img src={logo2} alt="Amrita" className="h-10 w-auto object-contain transform hover:scale-105 transition-transform duration-300" />
            <img src={logo3} alt="CWEGE" className="h-10 w-auto object-contain transform hover:scale-105 transition-transform duration-300" />
            <img src={logo1} alt="Ammachi Labs" className="h-8 w-auto object-contain transform hover:scale-105 transition-transform duration-300" />
          </div>
          <h1 className="text-3xl font-black text-slate-900 tracking-tight">Viveka AI</h1>
          <p className="text-slate-400 font-bold text-xs uppercase tracking-widest mt-2">Qualitative Verbatim Specialist</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          {isRegistering && (
            <div className="relative group">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 ml-1">Full Name</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <svg className="h-5 w-5 text-slate-400 group-focus-within:text-violet-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                  </svg>
                </div>
                <input 
                  type="text" 
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full bg-slate-50/50 border border-slate-200 rounded-xl pl-14 pr-4 py-3.5 font-semibold text-slate-700 placeholder:text-slate-300 focus:outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 transition-all"
                  placeholder="Your Full Name"
                />
              </div>
            </div>
          )}

          {isRegistering && (
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-2"> Select Affiliation</label>
                <select 
                  value={affiliation}
                  onChange={(e) => setAffiliation(e.target.value)}
                  className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-4 font-bold text-slate-700 focus:outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 transition-all"
                >
                  <option value="Academic">Academic</option>
                  <option value="Industry">Industry</option>
                  <option value="Research">Research</option>
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-2">Select Nationality</label>
                <div className="relative">
                  <button
                    type="button"
                    onClick={() => setIsCountryOpen(!isCountryOpen)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-4 font-bold text-slate-700 focus:outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 transition-all text-left flex items-center justify-between"
                  >
                    <span className="truncate pr-2">
                      {nationality ? (
                        <>
                          <span className="mr-2">{COUNTRIES.find(c => c.name === nationality)?.flag}</span>
                          {nationality}
                        </>
                      ) : "Select Country"}
                    </span>
                    <svg className="w-4 h-4 text-slate-400 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                  </button>
                  
                  {isCountryOpen && (
                    <>
                      <div className="fixed inset-0 z-10" onClick={() => setIsCountryOpen(false)}></div>
                      <div className="absolute z-20 w-[150%] right-0 mt-2 bg-white border border-slate-100 rounded-xl shadow-2xl max-h-60 overflow-hidden flex flex-col animate-fade-in">
                        <div className="p-2 border-b border-slate-100 sticky top-0 bg-white">
                          <input
                            type="text"
                            placeholder="Search country..."
                            value={countrySearch}
                            onChange={(e) => setCountrySearch(e.target.value)}
                            className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold text-slate-700 focus:outline-none focus:border-violet-500"
                            autoFocus
                          />
                        </div>
                        <div className="overflow-y-auto flex-1">
                          {filteredCountries.map(c => (
                            <button
                              key={c.name}
                              type="button"
                              onClick={() => {
                                setNationality(c.name);
                                setIsCountryOpen(false);
                                setCountrySearch('');
                              }}
                              className="w-full text-left px-4 py-2.5 hover:bg-violet-50 hover:text-violet-700 transition-colors flex items-center gap-3 border-b border-slate-50 last:border-0"
                            >
                              <span className="text-xl">{c.flag}</span>
                              <span className="text-xs font-bold text-slate-600">{c.name}</span>
                            </button>
                          ))}
                          {filteredCountries.length === 0 && (
                            <div className="p-4 text-center text-xs font-bold text-slate-400">No countries found</div>
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          <div className="relative group">
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 ml-1">Email ID</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-slate-400 group-focus-within:text-violet-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
              </div>
              <input 
                type="email" 
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-slate-50/50 border border-slate-200 rounded-xl pl-14 pr-4 py-3.5 font-semibold text-slate-700 placeholder:text-slate-300 focus:outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 transition-all"
                placeholder="user@example.com"
              />
            </div>
          </div>
          
          <div className="relative group">
            <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 ml-1">Password</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                <svg className="h-5 w-5 text-slate-400 group-focus-within:text-violet-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
              </div>
              <input 
                type={showPassword ? "text" : "password"} 
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-slate-50/50 border border-slate-200 rounded-xl pl-14 pr-12 py-3.5 font-semibold text-slate-700 placeholder:text-slate-300 focus:outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 transition-all"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPassword(!showPassword)}
                className="absolute inset-y-0 right-0 flex items-center px-4 text-slate-400 hover:text-violet-500"
              >
                {showPassword ? (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                  </svg>
                ) : (
                  <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7 1.274-4.057 5.064-7 9.542-7 .847 0 1.67.111 2.458.325m-4.25 4.25a3 3 0 11-4.243-4.243M3 3l18 18" />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {isRegistering && (
            <div className="relative group">
              <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 ml-1">Confirm Password</label>
              <div className="relative">
                <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
                  <svg className="h-5 w-5 text-slate-400 group-focus-within:text-violet-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                  </svg>
                </div>
                <input 
                  type={showPassword ? "text" : "password"} 
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  className="w-full bg-slate-50/50 border border-slate-200 rounded-xl pl-14 pr-12 py-3.5 font-semibold text-slate-700 placeholder:text-slate-300 focus:outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 transition-all"
                  placeholder="••••••••"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="absolute inset-y-0 right-0 flex items-center px-4 text-slate-400 hover:text-violet-500"
                >
                  {showPassword ? (
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" /></svg>
                  ) : (
                    <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.542-7 1.274-4.057 5.064-7 9.542-7 .847 0 1.67.111 2.458.325m-4.25 4.25a3 3 0 11-4.243-4.243M3 3l18 18" /></svg>
                  )}
                </button>
              </div>
            </div>
          )}

          <button 
            type="submit"
            className="w-full bg-slate-900 text-white py-4 rounded-xl font-bold text-sm uppercase tracking-widest shadow-lg hover:bg-violet-600 hover:shadow-violet-500/30 transition-all transform hover:-translate-y-1 active:scale-95 mt-2"
          >
            {isRegistering ? 'Create Account' : 'Login'}
          </button>

          <div className="text-center">
            <button 
              type="button"
              onClick={() => setIsRegistering(!isRegistering)}
              className="text-slate-400 text-[10px] font-bold uppercase tracking-widest hover:text-violet-600 transition-colors"
            >
              {isRegistering ? 'Already have an account? Login' : 'New User? Register Here'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// import React, { useState } from 'react';
// import { useNavigate } from 'react-router-dom';
// import { api } from '../services/api';

// import logo1 from '../assets/icons/ammachilabs-logo.png'; // NOTE: Update with your actual logo file names
// import logo2 from '../assets/icons/amrita-logo.png'; // NOTE: Update with your actual logo file names
// import logo3 from '../assets/icons/cwege_logo_black.png'; // NOTE: Update with your actual logo file names

// const COUNTRIES = [
//   { name: "India", flag: "🇮🇳" },
//   { name: "Afghanistan", flag: "🇦🇫" },
//   { name: "Albania", flag: "🇦🇱" },
//   { name: "Algeria", flag: "🇩🇿" },
//   { name: "Andorra", flag: "🇦🇩" },
//   { name: "Angola", flag: "🇦🇴" },
//   { name: "Antigua and Barbuda", flag: "🇦🇬" },
//   { name: "Argentina", flag: "🇦🇷" },
//   { name: "Armenia", flag: "🇦🇲" },
//   { name: "Australia", flag: "🇦🇺" },
//   { name: "Austria", flag: "🇦🇹" },
//   { name: "Azerbaijan", flag: "🇦🇿" },
//   { name: "Bahamas", flag: "🇧🇸" },
//   { name: "Bahrain", flag: "🇧🇭" },
//   { name: "Bangladesh", flag: "🇧🇩" },
//   { name: "Barbados", flag: "🇧🇧" },
//   { name: "Belarus", flag: "🇧🇾" },
//   { name: "Belgium", flag: "🇧🇪" },
//   { name: "Belize", flag: "🇧🇿" },
//   { name: "Benin", flag: "🇧🇯" },
//   { name: "Bhutan", flag: "🇧🇹" },
//   { name: "Bolivia", flag: "🇧🇴" },
//   { name: "Bosnia and Herzegovina", flag: "🇧🇦" },
//   { name: "Botswana", flag: "🇧🇼" },
//   { name: "Brazil", flag: "🇧🇷" },
//   { name: "Brunei", flag: "🇧🇳" },
//   { name: "Bulgaria", flag: "🇧🇬" },
//   { name: "Burkina Faso", flag: "🇧🇫" },
//   { name: "Burundi", flag: "🇧🇮" },
//   { name: "Cabo Verde", flag: "🇨🇻" },
//   { name: "Cambodia", flag: "🇰🇭" },
//   { name: "Cameroon", flag: "🇨🇲" },
//   { name: "Canada", flag: "🇨🇦" },
//   { name: "Central African Republic", flag: "🇨🇫" },
//   { name: "Chad", flag: "🇹🇩" },
//   { name: "Chile", flag: "🇨🇱" },
//   { name: "China", flag: "🇨🇳" },
//   { name: "Colombia", flag: "🇨🇴" },
//   { name: "Comoros", flag: "🇰🇲" },
//   { name: "Congo", flag: "🇨🇬" },
//   { name: "Costa Rica", flag: "🇨🇷" },
//   { name: "Croatia", flag: "🇭🇷" },
//   { name: "Cuba", flag: "🇨🇺" },
//   { name: "Cyprus", flag: "🇨🇾" },
//   { name: "Czech Republic", flag: "🇨🇿" },
//   { name: "Denmark", flag: "🇩🇰" },
//   { name: "Djibouti", flag: "🇩🇯" },
//   { name: "Dominica", flag: "🇩🇲" },
//   { name: "Dominican Republic", flag: "🇩🇴" },
//   { name: "Ecuador", flag: "🇪🇨" },
//   { name: "Egypt", flag: "🇪🇬" },
//   { name: "El Salvador", flag: "🇸🇻" },
//   { name: "Equatorial Guinea", flag: "🇬🇶" },
//   { name: "Eritrea", flag: "🇪🇷" },
//   { name: "Estonia", flag: "🇪🇪" },
//   { name: "Eswatini", flag: "🇸🇿" },
//   { name: "Ethiopia", flag: "🇪🇹" },
//   { name: "Fiji", flag: "🇫🇯" },
//   { name: "Finland", flag: "🇫🇮" },
//   { name: "France", flag: "🇫🇷" },
//   { name: "Gabon", flag: "🇬🇦" },
//   { name: "Gambia", flag: "🇬🇲" },
//   { name: "Georgia", flag: "🇬🇪" },
//   { name: "Germany", flag: "🇩🇪" },
//   { name: "Ghana", flag: "🇬🇭" },
//   { name: "Greece", flag: "🇬🇷" },
//   { name: "Grenada", flag: "🇬🇩" },
//   { name: "Guatemala", flag: "🇬🇹" },
//   { name: "Guinea", flag: "🇬🇳" },
//   { name: "Guinea-Bissau", flag: "🇬🇼" },
//   { name: "Guyana", flag: "🇬🇾" },
//   { name: "Haiti", flag: "🇭🇹" },
//   { name: "Honduras", flag: "🇭🇳" },
//   { name: "Hungary", flag: "🇭🇺" },
//   { name: "Iceland", flag: "🇮🇸" },
//   { name: "Indonesia", flag: "🇮🇩" },
//   { name: "Iran", flag: "🇮🇷" },
//   { name: "Iraq", flag: "🇮🇶" },
//   { name: "Ireland", flag: "🇮🇪" },
//   { name: "Israel", flag: "🇮🇱" },
//   { name: "Italy", flag: "🇮🇹" },
//   { name: "Jamaica", flag: "🇯🇲" },
//   { name: "Japan", flag: "🇯🇵" },
//   { name: "Jordan", flag: "🇯🇴" },
//   { name: "Kazakhstan", flag: "🇰🇿" },
//   { name: "Kenya", flag: "🇰🇪" },
//   { name: "Kiribati", flag: "🇰🇮" },
//   { name: "Kuwait", flag: "🇰🇼" },
//   { name: "Kyrgyzstan", flag: "🇰🇬" },
//   { name: "Laos", flag: "🇱🇦" },
//   { name: "Latvia", flag: "🇱🇻" },
//   { name: "Lebanon", flag: "🇱🇧" },
//   { name: "Lesotho", flag: "🇱🇸" },
//   { name: "Liberia", flag: "🇱🇷" },
//   { name: "Libya", flag: "🇱🇾" },
//   { name: "Liechtenstein", flag: "🇱🇮" },
//   { name: "Lithuania", flag: "🇱🇹" },
//   { name: "Luxembourg", flag: "🇱🇺" },
//   { name: "Madagascar", flag: "🇲🇬" },
//   { name: "Malawi", flag: "🇲🇼" },
//   { name: "Malaysia", flag: "🇲🇾" },
//   { name: "Maldives", flag: "🇲🇻" },
//   { name: "Mali", flag: "🇲🇱" },
//   { name: "Malta", flag: "🇲🇹" },
//   { name: "Marshall Islands", flag: "🇲🇭" },
//   { name: "Mauritania", flag: "🇲🇷" },
//   { name: "Mauritius", flag: "🇲🇺" },
//   { name: "Mexico", flag: "🇲🇽" },
//   { name: "Micronesia", flag: "🇫🇲" },
//   { name: "Moldova", flag: "🇲🇩" },
//   { name: "Monaco", flag: "🇲🇨" },
//   { name: "Mongolia", flag: "🇲🇳" },
//   { name: "Montenegro", flag: "🇲🇪" },
//   { name: "Morocco", flag: "🇲🇦" },
//   { name: "Mozambique", flag: "🇲🇿" },
//   { name: "Myanmar", flag: "🇲🇲" },
//   { name: "Namibia", flag: "🇳🇦" },
//   { name: "Nauru", flag: "🇳🇷" },
//   { name: "Nepal", flag: "🇳🇵" },
//   { name: "Netherlands", flag: "🇳🇱" },
//   { name: "New Zealand", flag: "🇳🇿" },
//   { name: "Nicaragua", flag: "🇳🇮" },
//   { name: "Niger", flag: "🇳🇪" },
//   { name: "Nigeria", flag: "🇳🇬" },
//   { name: "North Korea", flag: "🇰🇵" },
//   { name: "North Macedonia", flag: "🇲🇰" },
//   { name: "Norway", flag: "🇳🇴" },
//   { name: "Oman", flag: "🇴🇲" },
//   { name: "Pakistan", flag: "🇵🇰" },
//   { name: "Palau", flag: "🇵🇼" },
//   { name: "Panama", flag: "🇵🇦" },
//   { name: "Papua New Guinea", flag: "🇵🇬" },
//   { name: "Paraguay", flag: "🇵🇾" },
//   { name: "Peru", flag: "🇵🇪" },
//   { name: "Philippines", flag: "🇵🇭" },
//   { name: "Poland", flag: "🇵🇱" },
//   { name: "Portugal", flag: "🇵🇹" },
//   { name: "Qatar", flag: "🇶🇦" },
//   { name: "Romania", flag: "🇷🇴" },
//   { name: "Russia", flag: "🇷🇺" },
//   { name: "Rwanda", flag: "🇷🇼" },
//   { name: "Saint Kitts and Nevis", flag: "🇰🇳" },
//   { name: "Saint Lucia", flag: "🇱🇨" },
//   { name: "Saint Vincent and the Grenadines", flag: "🇻🇨" },
//   { name: "Samoa", flag: "🇼🇸" },
//   { name: "San Marino", flag: "🇸🇲" },
//   { name: "Sao Tome and Principe", flag: "🇸🇹" },
//   { name: "Saudi Arabia", flag: "🇸🇦" },
//   { name: "Senegal", flag: "🇸🇳" },
//   { name: "Serbia", flag: "🇷🇸" },
//   { name: "Seychelles", flag: "🇸🇨" },
//   { name: "Sierra Leone", flag: "🇸🇱" },
//   { name: "Singapore", flag: "🇸🇬" },
//   { name: "Slovakia", flag: "🇸🇰" },
//   { name: "Slovenia", flag: "🇸🇮" },
//   { name: "Solomon Islands", flag: "🇸🇧" },
//   { name: "Somalia", flag: "🇸🇴" },
//   { name: "South Africa", flag: "🇿🇦" },
//   { name: "South Korea", flag: "🇰🇷" },
//   { name: "South Sudan", flag: "🇸🇸" },
//   { name: "Spain", flag: "🇪🇸" },
//   { name: "Sri Lanka", flag: "🇱🇰" },
//   { name: "Sudan", flag: "🇸🇩" },
//   { name: "Suriname", flag: "🇸🇷" },
//   { name: "Sweden", flag: "🇸🇪" },
//   { name: "Switzerland", flag: "🇨🇭" },
//   { name: "Syria", flag: "🇸🇾" },
//   { name: "Tajikistan", flag: "🇹🇯" },
//   { name: "Tanzania", flag: "🇹🇿" },
//   { name: "Thailand", flag: "🇹🇭" },
//   { name: "Timor-Leste", flag: "🇹🇱" },
//   { name: "Togo", flag: "🇹🇬" },
//   { name: "Tonga", flag: "🇹🇴" },
//   { name: "Trinidad and Tobago", flag: "🇹🇹" },
//   { name: "Tunisia", flag: "🇹🇳" },
//   { name: "Turkey", flag: "🇹🇷" },
//   { name: "Turkmenistan", flag: "🇹🇲" },
//   { name: "Tuvalu", flag: "🇹🇻" },
//   { name: "Uganda", flag: "🇺🇬" },
//   { name: "Ukraine", flag: "🇺🇦" },
//   { name: "United Arab Emirates", flag: "🇦🇪" },
//   { name: "United Kingdom", flag: "🇬🇧" },
//   { name: "United States", flag: "🇺🇸" },
//   { name: "Uruguay", flag: "🇺🇾" },
//   { name: "Uzbekistan", flag: "🇺🇿" },
//   { name: "Vanuatu", flag: "🇻🇺" },
//   { name: "Venezuela", flag: "🇻🇪" },
//   { name: "Vietnam", flag: "🇻🇳" },
//   { name: "Yemen", flag: "🇾🇪" },
//   { name: "Zambia", flag: "🇿🇲" },
//   { name: "Zimbabwe", flag: "🇿🇼" }
// ];

// export const LoginPage: React.FC = () => {
//   const [email, setEmail] = useState('');
//   const [password, setPassword] = useState('');
//   const [name, setName] = useState('');
//   const [affiliation, setAffiliation] = useState('Academic');
//   const [nationality, setNationality] = useState('India');
//   const [isCountryOpen, setIsCountryOpen] = useState(false);
//   const [countrySearch, setCountrySearch] = useState('');
//   const [isRegistering, setIsRegistering] = useState(false);
//   const [showSuccess, setShowSuccess] = useState(false);
//   const navigate = useNavigate();

//   const filteredCountries = COUNTRIES.filter(c => 
//     c.name.toLowerCase().includes(countrySearch.toLowerCase())
//   );

//   const handleLogin = async (e: React.FormEvent) => {
//     e.preventDefault();

//     if (isRegistering) {
//       if (email && password && name) {
//         try {
//           // Simple mapping for nationality code (first 2 chars uppercase) or default to IN
//           const code = nationality === "India" ? "IN" : nationality.substring(0, 2).toUpperCase();
          
//           await api.register({
//             full_name: name,
//             email,
//             password,
//             nationality_code: code,
//             nationality_name: nationality,
//             affiliation
//           });
//           setShowSuccess(true);
//         } catch (error) {
//           alert("Registration failed. Please try again.");
//           console.error(error);
//         }
//       } else {
//         alert("Please fill in all fields to register.");
//       }
//     } else {
//       try {
//         const data = await api.login({ username: email, password });
        
//         localStorage.setItem('access_token', data.access_token);
        
//         // Construct a user object for local usage based on login info
//         const userObj = {
//           name: email.split('@')[0], // Fallback name
//           email: email,
//           isAdmin: data.roles.includes('admin'),
//           roles: data.roles
//         };
        
//         localStorage.setItem('viveka_user', JSON.stringify(userObj));
        
//         if (userObj.isAdmin) {
//           navigate('/admin');
//         } else {
//           navigate('/');
//         }
//       } catch (error) {
//         alert("Invalid credentials.");
//         console.error(error);
//       }
//     }
//   };

//   const handleSuccessDismiss = () => {
//     setShowSuccess(false);
//     setIsRegistering(false);
//     setEmail('');
//     setPassword('');
//     setName('');
//   };

//   if (showSuccess) {
//     return (
//       <div className="min-h-screen bg-slate-50 flex items-center justify-center p-4 font-sans relative overflow-hidden">
//         <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-violet-200/30 rounded-full blur-3xl animate-pulse"></div>
//         <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-200/30 rounded-full blur-3xl animate-pulse delay-1000"></div>
        
//         <div className="bg-white/80 backdrop-blur-xl p-12 rounded-[2.5rem] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.1)] w-full max-w-md border border-white/50 relative z-10 animate-fade-in text-center">
//           <div className="w-24 h-24 bg-green-50 rounded-full flex items-center justify-center mx-auto mb-8 shadow-inner">
//             <svg className="w-12 h-12 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
//               <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
//             </svg>
//           </div>
//           <h2 className="text-3xl font-black text-slate-800 mb-3 tracking-tight">Welcome Aboard!</h2>
//           <p className="text-slate-500 mb-10 font-medium">Your account has been successfully created.</p>
//           <button 
//             onClick={handleSuccessDismiss}
//             className="w-full bg-slate-900 text-white py-4 rounded-xl font-bold text-sm shadow-lg hover:bg-violet-600 hover:shadow-violet-500/30 transition-all transform hover:-translate-y-1 active:scale-95"
//           >
//             Proceed to Login
//           </button>
//         </div>
//       </div>
//     );
//   }

//   return (
//     <div className="min-h-screen bg-[#f8fafc] flex items-center justify-center p-4 font-sans relative overflow-hidden">
//       {/* Decorative background elements */}
//       <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-violet-200/30 rounded-full blur-3xl animate-pulse"></div>
//       <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-blue-200/30 rounded-full blur-3xl animate-pulse delay-1000"></div>

//       <div className="bg-white/80 backdrop-blur-xl p-8 md:p-10 rounded-[2.5rem] shadow-[0_20px_60px_-15px_rgba(0,0,0,0.1)] w-full max-w-[28rem] border border-white/50 relative z-10 animate-fade-in">
//         <div className="text-center mb-8">
//           <div className="flex justify-center items-center gap-6 mx-auto">
//             <img src={logo2} alt="Amrita" className="h-20 w-auto object-contain transform hover:scale-105 transition-transform duration-300" />
//             <img src={logo3} alt="CWEGE" className="h-20 w-auto object-contain transform hover:scale-105 transition-transform duration-300" />
//             <img src={logo1} alt="Ammachi Labs" className="h-14 w-auto object-contain transform hover:scale-105 transition-transform duration-300" />
//           </div>
//           <h1 className="text-3xl font-black text-slate-900 tracking-tight">Viveka AI</h1>
//           <p className="text-slate-400 font-bold text-xs uppercase tracking-widest mt-2">Qualitative Verbatim Specialist</p>
//         </div>

//         <form onSubmit={handleLogin} className="space-y-6">
//           {isRegistering && (
//             <div>
//               <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-2">Full Name</label>
//               <input 
//                 type="text" 
//                 value={name}
//                 onChange={(e) => setName(e.target.value)}
//                 className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-6 py-4 font-bold text-slate-700 focus:outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 transition-all"
//                 placeholder="Full Name"
//               />
//             </div>
//           )}

//           {isRegistering && (
//             <div className="grid grid-cols-2 gap-4">
//               <div>
//                 <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-2"> Select Affiliation</label>
//                 <select 
//                   value={affiliation}
//                   onChange={(e) => setAffiliation(e.target.value)}
//                   className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-4 font-bold text-slate-700 focus:outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 transition-all"
//                 >
//                   <option value="Academic">Academic</option>
//                   <option value="Industry">Industry</option>
//                   <option value="Research">Research</option>
//                 </select>
//               </div>
//               <div>
//                 <label className="block text-[10px] font-black text-slate-400 uppercase tracking-widest mb-2 ml-2">Select Nationality</label>
//                 <div className="relative">
//                   <button
//                     type="button"
//                     onClick={() => setIsCountryOpen(!isCountryOpen)}
//                     className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-4 font-bold text-slate-700 focus:outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 transition-all text-left flex items-center justify-between"
//                   >
//                     <span>
//                       {nationality ? (
//                         <>
//                           <span className="mr-2">{COUNTRIES.find(c => c.name === nationality)?.flag}</span>
//                           {nationality}
//                         </>
//                       ) : "Select Country"}
//                     </span>
//                     <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
//                   </button>
                  
//                   {isCountryOpen && (
//                     <>
//                       <div className="fixed inset-0 z-10" onClick={() => setIsCountryOpen(false)}></div>
//                       <div className="absolute z-20 w-[150%] right-0 mt-2 bg-white border border-slate-100 rounded-xl shadow-2xl max-h-60 overflow-hidden flex flex-col animate-fade-in">
//                         <div className="p-2 border-b border-slate-100 sticky top-0 bg-white">
//                           <input
//                             type="text"
//                             placeholder="Search country..."
//                             value={countrySearch}
//                             onChange={(e) => setCountrySearch(e.target.value)}
//                             className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-xs font-bold text-slate-700 focus:outline-none focus:border-violet-500"
//                             autoFocus
//                           />
//                         </div>
//                         <div className="overflow-y-auto flex-1">
//                           {filteredCountries.map(c => (
//                             <button
//                               key={c.name}
//                               type="button"
//                               onClick={() => {
//                                 setNationality(c.name);
//                                 setIsCountryOpen(false);
//                                 setCountrySearch('');
//                               }}
//                               className="w-full text-left px-4 py-2.5 hover:bg-violet-50 hover:text-violet-700 transition-colors flex items-center gap-3 border-b border-slate-50 last:border-0"
//                             >
//                               <span className="text-xl">{c.flag}</span>
//                               <span className="text-xs font-bold text-slate-600">{c.name}</span>
//                             </button>
//                           ))}
//                           {filteredCountries.length === 0 && (
//                             <div className="p-4 text-center text-xs font-bold text-slate-400">No countries found</div>
//                           )}
//                         </div>
//                       </div>
//                     </>
//                   )}
//                 </div>
//               </div>
//             </div>
//           )}

//           <div className="relative group">
//             <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 ml-1">Email ID</label>
//             <div className="relative">
//               <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
//                 <svg className="h-5 w-5 text-slate-400 group-focus-within:text-violet-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
//                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
//                 </svg>
//               </div>
//               <input 
//                 type="email" 
//                 value={email}
//                 onChange={(e) => setEmail(e.target.value)}
//                 className="w-full bg-slate-50/50 border border-slate-200 rounded-xl pl-14 pr-4 py-3.5 font-semibold text-slate-700 placeholder:text-slate-300 focus:outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 transition-all"
//                 placeholder="user@example.com"
//               />
//             </div>
//           </div>
          
//           <div className="relative group">
//             <label className="block text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1.5 ml-1">Password</label>
//             <div className="relative">
//               <div className="absolute inset-y-0 left-4 flex items-center pointer-events-none">
//                 <svg className="h-5 w-5 text-slate-400 group-focus-within:text-violet-500 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
//                   <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
//                 </svg>
//               </div>
//               <input 
//                 type="password" 
//                 value={password}
//                 onChange={(e) => setPassword(e.target.value)}
//                 className="w-full bg-slate-50/50 border border-slate-200 rounded-xl pl-14 pr-4 py-3.5 font-semibold text-slate-700 placeholder:text-slate-300 focus:outline-none focus:border-violet-500 focus:ring-4 focus:ring-violet-500/10 transition-all"
//                 placeholder="••••••••"
//               />
//             </div>
//           </div>

//           <button 
//             type="submit"
//             className="w-full bg-slate-900 text-white py-4 rounded-xl font-bold text-sm uppercase tracking-widest shadow-lg hover:bg-violet-600 hover:shadow-violet-500/30 transition-all transform hover:-translate-y-1 active:scale-95 mt-2"
//           >
//             {isRegistering ? 'Create Account' : 'Login'}
//           </button>

//           <div className="text-center">
//             <button 
//               type="button"
//               onClick={() => setIsRegistering(!isRegistering)}
//               className="text-slate-400 text-[10px] font-bold uppercase tracking-widest hover:text-violet-600 transition-colors"
//             >
//               {isRegistering ? 'Already have an account? Login' : 'New User? Register Here'}
//             </button>
//           </div>
//         </form>
//       </div>
//     </div>
//   );
// };