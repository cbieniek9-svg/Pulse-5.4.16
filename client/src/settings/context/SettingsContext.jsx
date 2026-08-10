import {
    createContext, useCallback, useContext, useEffect, useMemo, useRef, useState,
} from 'react';
import { useAuth } from '../../lib/auth.jsx';
import { useSettingsSync } from '../hooks/useSettingsSync.js';
import { apiAction, userCtx } from '../lib/settingsApi.js';

const SettingsContext = createContext(null);

const overlayStyle = {
    position: 'fixed',
    inset: 0,
    background: 'rgba(0,0,0,0.85)',
    zIndex: 99999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
};

const dialogStyle = {
    background: '#1f3b5c',
    padding: 25,
    borderRadius: 12,
    border: '2px solid #f90',
    color: '#fff',
    width: 'min(380px, calc(100vw - 32px))',
    textAlign: 'center',
};

export function SettingsProvider({ children }) {
    const { token, user } = useAuth();
    const {
        syncData,
        setSyncData,
        scheduleHealth,
        setScheduleHealth,
        loading,
        error,
        refresh,
        refreshScheduleHealth,
    } = useSettingsSync({ token, enabled: Boolean(token) });

    const [notices, setNotices] = useState([]);
    const [confirmState, setConfirmState] = useState(null);
    const [promptState, setPromptState] = useState(null);
    const [promptValue, setPromptValue] = useState('');
    const confirmRef = useRef(null);
    const promptRef = useRef(null);
    const promptInputRef = useRef(null);

    const showNotice = useCallback((message, type = 'info') => {
        const id = `${Date.now()}-${Math.random()}`;
        setNotices((prev) => [...prev, { id, message, type }]);
        setTimeout(() => {
            setNotices((prev) => prev.filter((n) => n.id !== id));
        }, 4500);
    }, []);

    const appConfirm = useCallback((message) => new Promise((resolve) => {
        confirmRef.current?.resolve(false);
        confirmRef.current = { resolve };
        setConfirmState({ message });
    }), []);

    /**
     * In-page prompt — window.prompt is unsupported / muted in Electron and on
     * kiosk Chromebooks, which made Staff → EDIT PIN look like a no-op.
     */
    const appPrompt = useCallback((message, defaultValue = '') => new Promise((resolve) => {
        promptRef.current?.resolve(null);
        promptRef.current = { resolve };
        setPromptValue(defaultValue == null ? '' : String(defaultValue));
        setPromptState({ message: String(message || '') });
    }), []);

    const closeConfirm = useCallback((result) => {
        confirmRef.current?.resolve(result);
        confirmRef.current = null;
        setConfirmState(null);
    }, []);

    const closePrompt = useCallback((result) => {
        promptRef.current?.resolve(result);
        promptRef.current = null;
        setPromptState(null);
        setPromptValue('');
    }, []);

    useEffect(() => {
        if (!promptState) return undefined;
        const t = requestAnimationFrame(() => {
            promptInputRef.current?.focus();
            promptInputRef.current?.select?.();
        });
        return () => cancelAnimationFrame(t);
    }, [promptState]);

    const doRefresh = useCallback(async () => {
        try {
            const data = await refresh();
            await refreshScheduleHealth();
            return data;
        } catch (e) {
            showNotice(e.message || 'Refresh failed', 'error');
            throw e;
        }
    }, [refresh, refreshScheduleHealth, showNotice]);

    const action = useCallback((table, act, data, id_col, id_val) => apiAction({
        table, action: act, data, id_col, id_val, token, user,
    }), [token, user]);

    const ctx = useMemo(() => ({
        token,
        user,
        syncData,
        setSyncData,
        scheduleHealth,
        setScheduleHealth,
        loading,
        error,
        refresh: doRefresh,
        refreshScheduleHealth,
        showNotice,
        appConfirm,
        appPrompt,
        action,
        userContext: userCtx(user),
    }), [
        token, user, syncData, setSyncData, scheduleHealth, setScheduleHealth,
        loading, error, doRefresh, refreshScheduleHealth,
        showNotice, appConfirm, appPrompt, action,
    ]);

    return (
        <SettingsContext.Provider value={ctx}>
            {children}
            <div id="notice-stack" className="mgr-notice-stack" aria-live="polite">
                {notices.map((n) => (
                    <div key={n.id} className={`mgr-notice ${n.type}`}>{n.message}</div>
                ))}
            </div>
            {confirmState ? (
                <div
                    role="presentation"
                    style={overlayStyle}
                    onClick={() => closeConfirm(false)}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        style={dialogStyle}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div style={{ marginBottom: 20, fontSize: '1em', textTransform: 'none' }}>
                            {confirmState.message}
                        </div>
                        <div style={{ display: 'flex', gap: 10 }}>
                            <button type="button" className="st-btn" style={{ flex: 1 }} onClick={() => closeConfirm(false)}>CANCEL</button>
                            <button type="button" className="st-btn" style={{ flex: 1, borderColor: '#0f8', color: '#0f8' }} onClick={() => closeConfirm(true)}>CONFIRM</button>
                        </div>
                    </div>
                </div>
            ) : null}
            {promptState ? (
                <div
                    role="presentation"
                    style={overlayStyle}
                    onClick={() => closePrompt(null)}
                >
                    <div
                        role="dialog"
                        aria-modal="true"
                        style={dialogStyle}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <div style={{ marginBottom: 14, fontSize: '1em', textTransform: 'none', textAlign: 'left' }}>
                            {promptState.message}
                        </div>
                        <input
                            ref={promptInputRef}
                            className="st-input"
                            value={promptValue}
                            onChange={(e) => setPromptValue(e.target.value)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                    e.preventDefault();
                                    closePrompt(promptValue);
                                } else if (e.key === 'Escape') {
                                    e.preventDefault();
                                    closePrompt(null);
                                }
                            }}
                            style={{ marginBottom: 16, textTransform: 'none' }}
                            autoComplete="off"
                        />
                        <div style={{ display: 'flex', gap: 10 }}>
                            <button type="button" className="st-btn" style={{ flex: 1 }} onClick={() => closePrompt(null)}>CANCEL</button>
                            <button type="button" className="st-btn" style={{ flex: 1, borderColor: '#0f8', color: '#0f8' }} onClick={() => closePrompt(promptValue)}>OK</button>
                        </div>
                    </div>
                </div>
            ) : null}
        </SettingsContext.Provider>
    );
}

export function useSettings() {
    const ctx = useContext(SettingsContext);
    if (!ctx) throw new Error('useSettings must be used within SettingsProvider');
    return ctx;
}
