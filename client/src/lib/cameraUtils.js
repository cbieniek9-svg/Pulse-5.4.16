export const HTTPS_SKIP_KEY = 'tgp_count_skip_https';

/**
 * UPC-A / EAN scans often include a leading zero the shelf tag does not.
 * Strip leading zeros from digit-only codes so the field matches the vendor tag.
 */
export function normalizeScannedCode(raw) {
    let s = String(raw ?? '').trim();
    if (!s) return '';
    s = s.replace(/[\s\-_.]/g, '');
    if (!s) return '';
    if (/^\d+$/.test(s)) {
        const stripped = s.replace(/^0+/, '');
        return stripped || '0';
    }
    return s;
}

export function beepScanOk() {
    try {
        if (navigator.vibrate) navigator.vibrate(40);
    } catch (_) { /* ignore */ }
    try {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) return;
        const ctx = new Ctx();
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.type = 'square';
        o.frequency.value = 880;
        g.gain.value = 0.04;
        o.connect(g);
        g.connect(ctx.destination);
        o.start();
        setTimeout(() => {
            try { o.stop(); ctx.close(); } catch (_) { /* ignore */ }
        }, 90);
    } catch (_) { /* ignore */ }
}

export function cameraHostIsLocal() {
    const h = String(window.location?.hostname || '').toLowerCase();
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]';
}

export function liveCameraAllowed() {
    return !!(window.isSecureContext || cameraHostIsLocal())
        && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
