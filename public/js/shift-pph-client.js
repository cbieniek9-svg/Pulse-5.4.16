/**
 * Live shift PPH tick between /api/sync polls (TV + mobile manager).
 */
(function (global) {
    'use strict';

    function resolveLiveOrderPieces(counts, hardwareArrived) {
        const g = Number(counts?.grocery ?? counts?.g ?? 0);
        const f = Number(counts?.frozen ?? counts?.f ?? 0);
        const h = Number(counts?.hardware ?? counts?.h ?? 0);
        const include = hardwareArrived === true || hardwareArrived === '1' || hardwareArrived === 1;
        return g + f + (include ? h : 0);
    }

    function computeLiveShiftPph(orderStartIso, totalPieces, now) {
        const startMs = Date.parse(orderStartIso || '');
        if (!Number.isFinite(startMs)) return null;
        const pieces = Number(totalPieces) || 0;
        const at = now instanceof Date ? now : new Date();
        const elapsedMins = Math.max(0, Math.round((at.getTime() - startMs) / 60000));
        const elapsedHours = elapsedMins / 60;
        if (elapsedHours <= 0) return null;
        return Number((pieces / elapsedHours).toFixed(1));
    }

    function formatElapsed(mins) {
        const m = Math.max(0, Math.round(mins));
        if (m < 1) return '0m';
        const h = Math.floor(m / 60);
        const r = m % 60;
        return h ? `${h}h ${r}m` : `${r}m`;
    }

    global.TgpShiftPph = { computeLiveShiftPph, formatElapsed, resolveLiveOrderPieces };
})(typeof window !== 'undefined' ? window : globalThis);
