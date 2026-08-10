import { useCallback, useEffect, useRef, useState } from 'react';
import { getReady } from './api.js';
import { cameraHostIsLocal, liveCameraAllowed, HTTPS_SKIP_KEY, normalizeScannedCode } from './cameraUtils.js';

let html5QrcodeModule = null;

async function loadHtml5Qrcode() {
    if (html5QrcodeModule) return html5QrcodeModule;
    try {
        html5QrcodeModule = await import('html5-qrcode');
        return html5QrcodeModule;
    } catch (_) {
        await new Promise((resolve, reject) => {
            if (window.Html5Qrcode) {
                resolve();
                return;
            }
            const existing = document.querySelector('script[data-count-html5-qrcode]');
            if (existing) {
                existing.addEventListener('load', resolve, { once: true });
                existing.addEventListener('error', reject, { once: true });
                return;
            }
            const script = document.createElement('script');
            const base = String(import.meta.env.BASE_URL || '/').replace(/\/?$/, '/');
            script.src = `${base}js/vendor/html5-qrcode.min.js`;
            script.dataset.countHtml5Qrcode = '1';
            script.onload = resolve;
            script.onerror = reject;
            document.head.appendChild(script);
        });
        html5QrcodeModule = {
            Html5Qrcode: window.Html5Qrcode,
            Html5QrcodeSupportedFormats: window.Html5QrcodeSupportedFormats,
        };
        return html5QrcodeModule;
    }
}

function inventoryBarcodeFormats(Html5QrcodeSupportedFormats) {
    const F = Html5QrcodeSupportedFormats;
    if (!F) return undefined;
    return [F.UPC_A, F.UPC_E, F.EAN_13, F.EAN_8, F.CODE_128, F.CODE_39, F.ITF, F.CODABAR];
}

function currentPortalPath() {
    return `${window.location.pathname}${window.location.search}`;
}

export default function useBarcodeCamera({ onDecode, onStatus, portalPath } = {}) {
    const scannerRef = useRef(null);
    const html5QrCodeRef = useRef(null);
    const lastUpcRef = useRef('');
    const lastAtRef = useRef(0);
    const cachedHttpsUrlRef = useRef('');
    const snapReaderRef = useRef(null);
    const startOpRef = useRef(0);
    const startLockRef = useRef(false);

    const [cameraOn, setCameraOn] = useState(false);
    const cameraOnRef = useRef(false);
    const [panelVisible, setPanelVisible] = useState(false);
    const [scanFlash, setScanFlash] = useState(false);
    const [httpsHintHtml, setHttpsHintHtml] = useState('');
    const [showTorchHint, setShowTorchHint] = useState(false);

    const setStatus = useCallback((msg, ok) => {
        if (typeof onStatus === 'function') onStatus(msg, ok);
    }, [onStatus]);

    const resolveHttpsPortalUrl = useCallback(async () => {
        if (cachedHttpsUrlRef.current) return cachedHttpsUrlRef.current;
        if (window.location.protocol === 'https:') {
            cachedHttpsUrlRef.current = window.location.href.split('#')[0];
            return cachedHttpsUrlRef.current;
        }
        try {
            const ready = await getReady();
            const port = ready?.https?.port;
            if (ready?.https?.enabled && port) {
                const path = portalPath || currentPortalPath();
                cachedHttpsUrlRef.current = `https://${window.location.hostname}:${port}${path}`;
                return cachedHttpsUrlRef.current;
            }
        } catch (_) { /* ignore */ }
        return '';
    }, [portalPath]);

    const cameraErrorMessage = useCallback(async (err) => {
        const name = err?.name || '';
        const msg = String(err?.message || err || '');
        const httpsUrl = cachedHttpsUrlRef.current || await resolveHttpsPortalUrl();
        if (!liveCameraAllowed()) {
            return httpsUrl
                ? `Live camera blocked on HTTP — open ${httpsUrl} (accept cert once)`
                : 'Live camera blocked on HTTP LAN — open the HTTPS link above';
        }
        if (name === 'NotAllowedError' || /permission|notallowed|denied/i.test(msg)) {
            return 'Camera permission denied — allow camera for this site';
        }
        if (name === 'NotFoundError' || /not found|no device/i.test(msg)) {
            return 'No camera found on this device';
        }
        if (name === 'NotReadableError' || /in use|readable/i.test(msg)) {
            return 'Camera busy — close other apps using it';
        }
        return msg || 'Camera failed — retry LIVE CAMERA';
    }, [resolveHttpsPortalUrl]);

    const updateCameraHints = useCallback(async () => {
        if (liveCameraAllowed()) {
            setHttpsHintHtml('');
            return;
        }
        const httpsUrl = await resolveHttpsPortalUrl();
        if (httpsUrl) {
            setHttpsHintHtml(
                `Live camera needs HTTPS. Open `
                + `<a href="${httpsUrl}" style="color:#ffb84d;font-weight:700;">${httpsUrl}</a>`
                + ` — accept the certificate warning once (Advanced → Proceed), then use LIVE CAMERA.`,
            );
        } else {
            setHttpsHintHtml(
                `Live camera needs HTTPS. You are on ${window.location.protocol}//${window.location.host}. `
                + 'Ask the store PC to start HTTPS (port 3443), then reopen this page.',
            );
        }
    }, [resolveHttpsPortalUrl]);

    const ensureQrScanner = useCallback(async () => {
        const mod = await loadHtml5Qrcode();
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = mod;
        if (!Html5Qrcode) throw new Error('Camera library missing — hard-refresh the page');
        if (!scannerRef.current?.id) throw new Error('Camera panel missing');
        const formats = inventoryBarcodeFormats(Html5QrcodeSupportedFormats);
        if (!html5QrCodeRef.current) {
            html5QrCodeRef.current = formats
                ? new Html5Qrcode(scannerRef.current.id, { formatsToSupport: formats })
                : new Html5Qrcode(scannerRef.current.id);
        }
        return { scanner: html5QrCodeRef.current, Html5Qrcode, formats, Html5QrcodeSupportedFormats };
    }, []);

    const handleDecode = useCallback(async (decodedText) => {
        const upc = normalizeScannedCode(decodedText);
        if (!upc) return;
        const now = Date.now();
        if (upc === lastUpcRef.current && now - lastAtRef.current < 1500) return;
        lastUpcRef.current = upc;
        lastAtRef.current = now;
        if (typeof onDecode === 'function') await onDecode(upc);
    }, [onDecode]);

    const stopCamera = useCallback(async () => {
        startOpRef.current += 1;
        setShowTorchHint(false);
        setPanelVisible(false);
        if (html5QrCodeRef.current && cameraOnRef.current) {
            try { await html5QrCodeRef.current.stop(); } catch (_) { /* ignore */ }
            try { await html5QrCodeRef.current.clear(); } catch (_) { /* ignore */ }
        }
        cameraOnRef.current = false;
        setCameraOn(false);
    }, []);

    const startCamera = useCallback(async () => {
        // Serialize scanner.start on the shared instance — concurrent startups race tracks/state.
        if (startLockRef.current) return;
        startLockRef.current = true;
        const opId = ++startOpRef.current;
        try {
            await updateCameraHints();
            if (opId !== startOpRef.current) return;
            if (!liveCameraAllowed()) {
                setStatus(await cameraErrorMessage({ name: 'SecurityError' }), false);
                const httpsUrl = await resolveHttpsPortalUrl();
                if (opId !== startOpRef.current) return;
                if (httpsUrl) window.location.assign(httpsUrl);
                return;
            }

            setPanelVisible(true);
            setStatus('Requesting camera…', true);

            const preflight = await navigator.mediaDevices.getUserMedia({
                audio: false,
                video: { facingMode: { ideal: 'environment' } },
            });
            preflight.getTracks().forEach((t) => t.stop());
            if (opId !== startOpRef.current) return;

            const { scanner, Html5Qrcode } = await ensureQrScanner();
            if (opId !== startOpRef.current) return;
            if (cameraOnRef.current) {
                try { await scanner.stop(); } catch (_) { /* ignore */ }
            }

            const config = {
                fps: 12,
                qrbox: (viewW, viewH) => {
                    const w = Math.min(320, Math.floor(viewW * 0.92));
                    const h = Math.min(180, Math.floor(viewH * 0.42));
                    return { width: w, height: h };
                },
                aspectRatio: 1.333,
                experimentalFeatures: { useBarCodeDetectorIfSupported: true },
            };

            let cameraConfig = { facingMode: 'environment' };
            try {
                const cams = await Html5Qrcode.getCameras();
                if (cams?.length) {
                    const back = cams.find((c) => /back|rear|environment/i.test(c.label || '')) || cams[cams.length - 1];
                    cameraConfig = back.id;
                }
            } catch (_) { /* facingMode fallback */ }

            if (opId !== startOpRef.current) return;
            await scanner.start(
                cameraConfig,
                config,
                (text) => { handleDecode(text); },
                () => {},
            );
            if (opId !== startOpRef.current) {
                try { await scanner.stop(); } catch (_) { /* ignore */ }
                try { await scanner.clear(); } catch (_) { /* ignore */ }
                return;
            }
            cameraOnRef.current = true;
            setCameraOn(true);
            setShowTorchHint(true);
            setStatus('Camera ready — point at barcode', true);
        } catch (err) {
            if (opId !== startOpRef.current) return;
            cameraOnRef.current = false;
            setCameraOn(false);
            setPanelVisible(false);
            setStatus(await cameraErrorMessage(err), false);
        } finally {
            startLockRef.current = false;
        }
    }, [cameraErrorMessage, ensureQrScanner, handleDecode, resolveHttpsPortalUrl, setStatus, updateCameraHints]);

    const toggleCamera = useCallback(async () => {
        if (cameraOnRef.current) await stopCamera();
        else await startCamera();
    }, [startCamera, stopCamera]);

    const flashCameraPanel = useCallback(() => {
        if (!panelVisible) return;
        setScanFlash(true);
        setTimeout(() => setScanFlash(false), 500);
    }, [panelVisible]);

    const decodeSnapWithBarcodeDetector = useCallback(async (file) => {
        if (typeof BarcodeDetector === 'undefined') return null;
        const detector = new BarcodeDetector({
            formats: ['upc_a', 'upc_e', 'ean_13', 'ean_8', 'code_128', 'code_39', 'itf', 'codabar'],
        });
        const bitmap = await createImageBitmap(file);
        try {
            const codes = await detector.detect(bitmap);
            const raw = codes?.[0]?.rawValue;
            return raw ? String(raw).trim() : null;
        } finally {
            try { bitmap.close(); } catch (_) { /* ignore */ }
        }
    }, []);

    const decodeSnapWithHtml5 = useCallback(async (file) => {
        const mod = await loadHtml5Qrcode();
        const { Html5Qrcode, Html5QrcodeSupportedFormats } = mod;
        if (!Html5Qrcode) throw new Error('Camera library missing — hard-refresh');
        if (!snapReaderRef.current?.id) throw new Error('Snap reader missing');
        const formats = inventoryBarcodeFormats(Html5QrcodeSupportedFormats);
        const scanner = formats
            ? new Html5Qrcode(snapReaderRef.current.id, { formatsToSupport: formats })
            : new Html5Qrcode(snapReaderRef.current.id);
        try {
            const text = await scanner.scanFile(file, false);
            return text ? String(text).trim() : null;
        } finally {
            try { await scanner.clear(); } catch (_) { /* ignore */ }
        }
    }, []);

    const onSnapBarcode = useCallback(async (file) => {
        if (!file) return;
        setStatus('Reading barcode…', true);
        try {
            if (cameraOnRef.current) await stopCamera();
            let text = null;
            try { text = await decodeSnapWithBarcodeDetector(file); } catch (_) { text = null; }
            if (!text) text = await decodeSnapWithHtml5(file);
            if (!text) throw new Error('No barcode found in photo');
            await handleDecode(text);
        } catch (err) {
            const msg = String(err?.message || err || '');
            setStatus(
                /not found|no barcode|QR code parse|No MultiFormat Readers/i.test(msg)
                    ? 'No barcode found — retake closer / fill the frame'
                    : (await cameraErrorMessage(err) || msg),
                false,
            );
        }
    }, [cameraErrorMessage, decodeSnapWithBarcodeDetector, decodeSnapWithHtml5, handleDecode, setStatus, stopCamera]);

    useEffect(() => {
        updateCameraHints();
    }, [updateCameraHints]);

    useEffect(() => () => {
        startOpRef.current += 1;
        if (html5QrCodeRef.current) {
            html5QrCodeRef.current.stop().catch(() => {});
            html5QrCodeRef.current.clear().catch(() => {});
        }
    }, []);

    return {
        scannerRef,
        snapReaderRef,
        cameraOn,
        panelVisible,
        scanFlash,
        httpsHintHtml,
        showTorchHint,
        toggleCamera,
        stopCamera,
        startCamera,
        onSnapBarcode,
        flashCameraPanel,
        updateCameraHints,
    };
}

export async function preferHttpsForCamera() {
    if (window.location.protocol === 'https:') return;
    if (sessionStorage.getItem(HTTPS_SKIP_KEY) === '1') return;
    if (cameraHostIsLocal()) return;
    try {
        const ready = await getReady();
        const httpsPort = ready?.https?.port;
        if (!ready?.https?.enabled || !httpsPort) return;
        const dest = `https://${window.location.hostname}:${httpsPort}${window.location.pathname}${window.location.search}${window.location.hash}`;
        window.location.replace(dest);
    } catch (_) { /* stay on HTTP */ }
}
