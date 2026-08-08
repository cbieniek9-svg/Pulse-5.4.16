import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { mobileAuth, onSessionExpired, revokeSession } from './api.js';

const TOKEN_KEY = 'tgp_token';
const USER_KEY = 'tgp_user';
/** Survives logout so managers (hidden from the public roster) can reopen typed unlock. */
const LAST_LOGIN_KEY = 'tgp_last_login';

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
    const [token, setToken] = useState(() => {
        try { return sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) { return ''; }
    });
    const [user, setUser] = useState(() => {
        try { return localStorage.getItem(USER_KEY) || ''; } catch (_) { return ''; }
    });

    const login = useCallback(async (name, pin) => {
        const result = await mobileAuth(name, pin);
        const next = result?.token || '';
        if (!next) throw new Error('Login did not return a session token.');
        const userName = result?.user?.name || name;
        sessionStorage.setItem(TOKEN_KEY, next);
        localStorage.removeItem('tgp_token');
        localStorage.setItem(USER_KEY, userName);
        try { localStorage.setItem(LAST_LOGIN_KEY, userName); } catch (_) { /* storage unavailable */ }
        setToken(next);
        setUser(userName);
        return next;
    }, []);

    /** Drop local credentials only — used when the server has already invalidated the token. */
    const clearSession = useCallback(() => {
        try {
            sessionStorage.removeItem(TOKEN_KEY);
            localStorage.removeItem(USER_KEY);
            // Keep LAST_LOGIN_KEY — public login hides managers; typed unlock needs the name.
        } catch (_) { /* storage unavailable */ }
        setToken('');
        setUser('');
    }, []);

    const logout = useCallback(() => {
        let stale = '';
        try { stale = sessionStorage.getItem(TOKEN_KEY) || ''; } catch (_) { /* storage unavailable */ }
        if (stale) revokeSession(stale);
        clearSession();
    }, [clearSession]);

    // Deliberately clearSession, not logout: the token is already dead, so posting a
    // revoke would be pointless and risks re-entering this handler.
    useEffect(() => {
        onSessionExpired(clearSession);
        return () => onSessionExpired(null);
    }, [clearSession]);

    const value = useMemo(() => ({
        token,
        user,
        isAuthenticated: Boolean(token),
        login,
        logout,
    }), [token, user, login, logout]);

    return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
    const ctx = useContext(AuthContext);
    if (!ctx) throw new Error('useAuth must be used within AuthProvider');
    return ctx;
}
