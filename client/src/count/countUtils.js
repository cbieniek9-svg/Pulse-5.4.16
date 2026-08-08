export {
    HTTPS_SKIP_KEY, beepScanOk, cameraHostIsLocal, liveCameraAllowed,
} from '../lib/cameraUtils.js';

export const RECENT_LIMIT = 5;

export function formatTime(iso) {
    if (!iso) return '';
    const d = new Date(iso.includes('T') ? iso : `${String(iso).replace(' ', 'T')}Z`);
    if (Number.isNaN(d.getTime())) return String(iso);
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function downloadBlob(blob, filename) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(a.href);
}
