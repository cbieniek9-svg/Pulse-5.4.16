import {
    createContext, useCallback, useContext, useMemo, useRef, useState,
} from 'react';
import { useAuth } from '../../lib/auth.jsx';
import { useSync } from '../../providers/SyncProvider.jsx';
import { createFloorActions } from '../../lib/floorActions.js';
import OrderFinishGateModal from '../floor/OrderFinishGateModal.jsx';

const NoticeContext = createContext(null);

export function NoticeProvider({ children }) {
    const [notices, setNotices] = useState([]);
    const confirmRef = useRef(null);
    const finishGateRef = useRef(null);

    const showNotice = useCallback((message, type = 'info') => {
        const id = `${Date.now()}-${Math.random()}`;
        setNotices((prev) => [...prev, { id, message, type }]);
        setTimeout(() => {
            setNotices((prev) => prev.filter((n) => n.id !== id));
        }, 4500);
    }, []);

    const [confirmState, setConfirmState] = useState(null);
    const [finishGateOpen, setFinishGateOpen] = useState(false);
    const [finishGateClock, setFinishGateClock] = useState('dry');

    const appConfirm = useCallback((message, title = 'Confirm action') => new Promise((resolve) => {
        confirmRef.current?.resolve(false);
        confirmRef.current = { message, title, resolve };
        setConfirmState({ message, title });
    }), []);

    const appPrompt = useCallback((message, defaultValue = '') => new Promise((resolve) => {
        const value = window.prompt(message, defaultValue);
        resolve(value);
    }), []);

    const appOrderFinishGate = useCallback((opts = {}) => new Promise((resolve) => {
        finishGateRef.current?.resolve(null);
        const clockKind = opts.clockKind === 'frozen' ? 'frozen' : 'dry';
        finishGateRef.current = { resolve, clockKind };
        setFinishGateClock(clockKind);
        setFinishGateOpen(true);
    }), []);

    const closeConfirm = useCallback((result) => {
        confirmRef.current?.resolve(result);
        confirmRef.current = null;
        setConfirmState(null);
    }, []);

    const closeFinishGate = useCallback((result) => {
        const kind = finishGateRef.current?.clockKind || 'dry';
        if (result && typeof result === 'object') {
            finishGateRef.current?.resolve({ ...result, clock_kind: kind });
        } else {
            finishGateRef.current?.resolve(result);
        }
        finishGateRef.current = null;
        setFinishGateOpen(false);
    }, []);

    const { token, user } = useAuth();
    const { syncData, sync, postAction } = useSync();

    const actions = useMemo(() => createFloorActions({
        token,
        user,
        sync,
        postActionFn: postAction,
        showNotice,
        appConfirm,
        appPrompt,
        appOrderFinishGate,
        syncData,
    }), [token, user, sync, postAction, showNotice, appConfirm, appPrompt, appOrderFinishGate, syncData]);

    const value = useMemo(() => ({
        showNotice,
        appConfirm,
        appPrompt,
        appOrderFinishGate,
        actions,
    }), [showNotice, appConfirm, appPrompt, appOrderFinishGate, actions]);

    return (
        <NoticeContext.Provider value={value}>
            {children}
            <div className="notice-stack" aria-live="polite" aria-atomic="true">
                {notices.map((n) => (
                    <div key={n.id} className={`notice notice-${n.type}`}>{n.message}</div>
                ))}
            </div>
            {confirmState ? (
                // mobile.css keeps .confirm-backdrop { display:none } for the always-mounted
                // #confirm-backdrop in mobile.html — React only mounts when open, so force flex.
                <div className="confirm-backdrop" role="presentation" style={{ display: 'flex' }}>
                    <div className="confirm-panel" role="dialog" aria-modal="true">
                        <div className="confirm-header">{confirmState.title}</div>
                        <div className="confirm-body">{confirmState.message}</div>
                        <div className="confirm-actions">
                            <button type="button" className="st-btn subtle" onClick={() => closeConfirm(false)}>Cancel</button>
                            <button type="button" className="st-btn" onClick={() => closeConfirm(true)}>Confirm</button>
                        </div>
                    </div>
                </div>
            ) : null}
            {finishGateOpen ? (
                <OrderFinishGateModal
                    syncData={syncData}
                    clockKind={finishGateClock}
                    onCancel={() => closeFinishGate(null)}
                    onConfirm={(payload) => closeFinishGate(payload)}
                />
            ) : null}
        </NoticeContext.Provider>
    );
}

export function useFloorUi() {
    const ctx = useContext(NoticeContext);
    if (!ctx) throw new Error('useFloorUi must be used within NoticeProvider');
    return ctx;
}
