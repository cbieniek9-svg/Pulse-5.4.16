/**
 * Shared SSE client for Command Center surfaces (mobile, TV, markdown, rec).
 * Trusted TVs/devices use x-device-token; legacy trusted TV IPs remain as a fallback.
 */
(function (global) {
    'use strict';

    /**
     * @param {object} opts
     * @param {string} [opts.apiBase]
     * @param {string} [opts.token] session token for stream-token exchange
     * @param {string} [opts.deviceToken] trusted device token for TV/display clients
     * @param {function} [opts.onEvent] (message) => void — { type: 'REFRESH'|'DELTA', ... }
     * @param {function} [opts.onOpen]
     * @param {function} [opts.onError]
     */
    function connect(opts = {}) {
        const apiBase = opts.apiBase || '';
        const token = opts.token || '';
        const deviceToken = opts.deviceToken || '';
        let es = null;
        let reconnectTimer = null;
        let reconnectCount = 0;
        let closed = false;

        function resolveUrl(path) {
            if (/^https?:\/\//i.test(path)) return path;
            return path.startsWith('/') ? apiBase + path : apiBase + '/' + path;
        }

        async function open() {
            if (closed) return;
            if (es) { es.close(); es = null; }
            if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
            try {
                let url = resolveUrl('/api/stream');
                if (token || deviceToken) {
                    const headers = { 'Content-Type': 'application/json' };
                    if (deviceToken) headers['x-device-token'] = deviceToken;
                    const r = await fetch(resolveUrl('/api/stream-token'), {
                        method: 'POST',
                        headers,
                        body: JSON.stringify({ token, deviceToken }),
                    });
                    if (!r.ok) throw new Error('stream-token failed');
                    const { streamToken } = await r.json();
                    url += `?st=${encodeURIComponent(streamToken)}`;
                }
                es = new EventSource(url);
                es.onmessage = (e) => {
                    try {
                        const m = JSON.parse(e.data);
                        opts.onEvent?.(m);
                    } catch (_) { /* ignore keep-alive */ }
                };
                es.onopen = () => {
                    reconnectCount = 0;
                    opts.onOpen?.();
                };
                es.onerror = () => {
                    es?.close();
                    es = null;
                    opts.onError?.();
                    if (closed) return;
                    reconnectCount += 1;
                    const delay = Math.min(30000, Math.pow(2, reconnectCount) * 1000) + Math.random() * 500;
                    reconnectTimer = setTimeout(open, delay);
                };
            } catch (err) {
                opts.onError?.(err);
                if (closed) return;
                reconnectCount += 1;
                const delay = Math.min(30000, Math.pow(2, reconnectCount) * 1000);
                reconnectTimer = setTimeout(open, delay);
            }
        }

        function close() {
            closed = true;
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = null;
            if (es) { es.close(); es = null; }
        }

        open();
        return { close, reconnect: () => { closed = false; open(); } };
    }

    global.TgpStream = { connect };
})(typeof window !== 'undefined' ? window : globalThis);
