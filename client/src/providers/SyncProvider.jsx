import {
    createContext,
    useCallback,
    useContext,
    useEffect,
    useMemo,
    useRef,
    useState,
} from 'react';
import { getSync, resolveUrl } from '../lib/api.js';
import { postAction as postActionApi } from '../lib/actions.js';
import {
    applyDelta,
    applyOptimisticAction,
    applySyncPayload,
} from '../lib/syncReducer.js';
import { useAuth } from '../lib/auth.jsx';

const SYNC_INTERVAL_MS = 90_000;

const SyncContext = createContext(null);

function connectStream({ token, onEvent, onOpen, onError }) {
    let es = null;
    let reconnectTimer = null;
    let reconnectCount = 0;
    let closed = false;

    async function open() {
        if (closed) return;
        if (es) { es.close(); es = null; }
        if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

        try {
            let url = resolveUrl('/api/stream');
            if (token) {
                const r = await fetch(resolveUrl('/api/stream-token'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token }),
                });
                if (!r.ok) throw new Error('stream-token failed');
                const { streamToken } = await r.json();
                url += `?st=${encodeURIComponent(streamToken)}`;
            }

            es = new EventSource(url);
            es.onmessage = (e) => {
                try {
                    const m = JSON.parse(e.data);
                    onEvent?.(m);
                } catch (_) { /* keep-alive */ }
            };
            es.onopen = () => {
                reconnectCount = 0;
                onOpen?.();
            };
            es.onerror = () => {
                es?.close();
                es = null;
                onError?.();
                if (closed) return;
                reconnectCount += 1;
                const delay = Math.min(30_000, 2 ** reconnectCount * 1000) + Math.random() * 500;
                reconnectTimer = setTimeout(open, delay);
            };
        } catch (err) {
            onError?.(err);
            if (closed) return;
            reconnectCount += 1;
            const delay = Math.min(30_000, 2 ** reconnectCount * 1000);
            reconnectTimer = setTimeout(open, delay);
        }
    }

    open();

    return {
        close() {
            closed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = null;
            if (es) { es.close(); es = null; }
        },
    };
}

function isUnreachableFetchError(err) {
    const msg = String(err?.message || err || '');
    return /failed to fetch|networkerror|load failed|network request failed/i.test(msg);
}

export function SyncProvider({ children }) {
    const { token, user, logout, isAuthenticated } = useAuth();
    const [syncData, setSyncData] = useState(null);
    const [connected, setConnected] = useState(false);

    const syncInFlight = useRef(false);
    const queuedForceSync = useRef(false);
    const streamRef = useRef(null);
    const lastSyncErrorLogAt = useRef(0);
    const apiUnreachable = useRef(false);

    const sync = useCallback(async (force = false) => {
        if (!token || !navigator.onLine) return;

        if (syncInFlight.current) {
            if (force) queuedForceSync.current = true;
            return;
        }

        syncInFlight.current = true;
        try {
            const data = await getSync(token);
            apiUnreachable.current = false;
            if (data?.sessionActive === false) {
                logout();
                setSyncData(null);
                setConnected(false);
                return;
            }
            if (data?.staff) {
                setSyncData((prev) => applySyncPayload(prev, data));
                setConnected(true);
            }
        } catch (e) {
            setConnected(false);
            const unreachable = isUnreachableFetchError(e);
            apiUnreachable.current = unreachable;
            const now = Date.now();
            // Stream reconnect + visibility sync both call getSync; collapse identical
            // "Failed to fetch" spam (Chrome "N hidden") when the API/service is down.
            if (!unreachable || now - lastSyncErrorLogAt.current > 15_000) {
                lastSyncErrorLogAt.current = now;
                if (unreachable) {
                    console.error(
                        '[SYNC] API unreachable — is TGP Command Center running on :3001?',
                        e.message,
                    );
                } else {
                    console.error('[SYNC]', e.message);
                }
            }
        } finally {
            syncInFlight.current = false;
            if (queuedForceSync.current) {
                queuedForceSync.current = false;
                void sync(true);
            }
        }
    }, [token, logout]);

    const handleDeltaEvent = useCallback((message) => {
        if (message?.type === 'REFRESH') {
            void sync(true);
            return;
        }
        if (message?.type !== 'DELTA') return;

        setSyncData((prev) => {
            const result = applyDelta(prev, message);
            if (result.needsSync) {
                void sync(result.urgent ?? false);
            }
            return result.state;
        });
    }, [sync]);

    const postAction = useCallback(async ({ table, action, data, id_col, id_val }) => {
        const userContext = user ? { name: user, token } : null;
        let hadOptimistic = false;

        setSyncData((prev) => {
            const optimistic = applyOptimisticAction(prev, table, action, data, id_col, id_val);
            if (optimistic) hadOptimistic = true;
            return optimistic || prev;
        });

        try {
            await postActionApi({ table, action, data, id_col, id_val, token, userContext });
            if (!hadOptimistic) await sync(true);
        } catch (err) {
            if (hadOptimistic) await sync(true);
            throw err;
        }
    }, [token, user, sync]);

    useEffect(() => {
        if (!isAuthenticated || !token) {
            setSyncData(null);
            setConnected(false);
            streamRef.current?.close();
            streamRef.current = null;
            return undefined;
        }

        void sync(true);

        streamRef.current?.close();
        streamRef.current = connectStream({
            token,
            onEvent: handleDeltaEvent,
            onOpen: () => {
                apiUnreachable.current = false;
                setConnected(true);
            },
            onError: () => {
                setConnected(false);
                // Skip forced sync while API is known-down — reconnect already backs off.
                if (token && !apiUnreachable.current) void sync(true);
            },
        });

        const intervalId = setInterval(() => { void sync(false); }, SYNC_INTERVAL_MS);

        const onVisible = () => {
            if (document.visibilityState === 'visible' && token) void sync(true);
        };
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onVisible);

        return () => {
            clearInterval(intervalId);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onVisible);
            streamRef.current?.close();
            streamRef.current = null;
        };
    }, [isAuthenticated, token, sync, handleDeltaEvent]);

    const value = useMemo(() => ({
        syncData,
        connected,
        sync,
        postAction,
    }), [syncData, connected, sync, postAction]);

    return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync() {
    const ctx = useContext(SyncContext);
    if (!ctx) throw new Error('useSync must be used within SyncProvider');
    return ctx;
}
