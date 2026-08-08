import { useEffect, useRef, useState } from 'react';
import { resolveUrl } from '../lib/api.js';

/**
 * Compare tables by value so parents can pass inline arrays without
 * tearing down EventSource on every render.
 */
export function usePortalStream({ token, tables = [], onEvent, onOpen }) {
    const tablesKey = Array.isArray(tables) ? tables.join('\0') : '';
    const onEventRef = useRef(onEvent);
    const onOpenRef = useRef(onOpen);
    const tablesRef = useRef(tables);
    onEventRef.current = onEvent;
    onOpenRef.current = onOpen;
    tablesRef.current = tables;

    useEffect(() => {
        if (!token) return undefined;
        let es = null;
        let reconnectTimer = null;
        let closed = false;
        let reconnectCount = 0;

        async function open() {
            if (closed) return;
            if (es) { es.close(); es = null; }
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

            try {
                let url = resolveUrl('/api/stream');
                const r = await fetch(resolveUrl('/api/stream-token'), {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ token }),
                });
                if (!r.ok) throw new Error('stream-token failed');
                const { streamToken } = await r.json();
                url += `?st=${encodeURIComponent(streamToken)}`;

                es = new EventSource(url);
                es.onopen = () => onOpenRef.current?.();
                es.onmessage = (e) => {
                    try {
                        const m = JSON.parse(e.data);
                        if (m?.type === 'REFRESH') {
                            onEventRef.current?.(m);
                            return;
                        }
                        const watch = tablesRef.current || [];
                        if (m?.type === 'DELTA' && (!watch.length || watch.includes(m.table))) {
                            onEventRef.current?.(m);
                        }
                    } catch (_) { /* keep-alive */ }
                };
                es.onerror = () => {
                    es?.close();
                    es = null;
                    if (closed) return;
                    reconnectCount += 1;
                    const delay = Math.min(30_000, 2 ** reconnectCount * 1000);
                    reconnectTimer = setTimeout(open, delay);
                };
            } catch (_) {
                if (closed) return;
                reconnectCount += 1;
                reconnectTimer = setTimeout(open, Math.min(30_000, 2 ** reconnectCount * 1000));
            }
        }

        open();
        return () => {
            closed = true;
            es?.close();
            if (reconnectTimer) clearTimeout(reconnectTimer);
        };
    }, [token, tablesKey]);
}
