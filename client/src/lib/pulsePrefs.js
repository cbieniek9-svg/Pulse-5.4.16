const keys = {
    intensity: 'tgp_pulse_intensity',
    textScale: 'tgp_pulse_text_scale',
    lang: 'tgp_pulse_lang',
};

export const PULSE_LANG_CHANGE = 'tgp-pulse-lang-change';

const intensities = new Set(['', 'bridge', 'standard', 'highcontrast', 'dockglare']);
const scales = new Set(['', 'normal', 'large', 'xl']);

function storageGet(key, fallback) {
    try {
        const value = localStorage.getItem(key);
        return value == null ? fallback : value;
    } catch (_) {
        return fallback;
    }
}

function storageSet(key, value) {
    try {
        if (value == null || value === '') localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch (_) { /* ignore */ }
}

function normalizeIntensity(value) {
    const next = String(value || 'bridge').toLowerCase();
    if (next === 'standard' || next === '') return 'bridge';
    return intensities.has(next) ? next : 'bridge';
}

function normalizeScale(value) {
    const next = String(value || 'normal').toLowerCase();
    return scales.has(next) ? next : 'normal';
}

function ensureBody() {
    if (!document.body) return null;
    document.body.classList.add('pulse-holo');
    return document.body;
}

function applyIntensity(value) {
    const body = ensureBody();
    if (!body) return 'bridge';
    const next = normalizeIntensity(value);
    body.classList.remove(
        'pulse-intensity-bridge',
        'pulse-intensity-highcontrast',
        'pulse-intensity-dockglare',
    );
    body.classList.add(`pulse-intensity-${next}`);
    body.dataset.pulseIntensity = next;
    return next;
}

function applyScale(value) {
    const next = normalizeScale(value);
    if (next === 'large' || next === 'xl') {
        document.documentElement.dataset.textScale = next;
    } else {
        delete document.documentElement.dataset.textScale;
    }
    return next;
}

function applyLang(value) {
    const stored = storageGet(keys.lang, 'en');
    const raw = value != null ? value : stored;
    if (typeof window !== 'undefined' && window.PulseI18n?.apply) {
        const next = window.PulseI18n.apply(raw);
        return next;
    }
    const lang = String(raw || document.documentElement.lang || 'en');
    document.documentElement.lang = lang;
    return lang;
}

function notifyLangChange(lang) {
    if (typeof window === 'undefined') return;
    window.dispatchEvent(new CustomEvent(PULSE_LANG_CHANGE, { detail: lang }));
}

export function getPulseState() {
    return {
        intensity: applyIntensity(storageGet(keys.intensity, 'bridge')),
        textScale: applyScale(storageGet(keys.textScale, 'normal')),
        lang: applyLang(storageGet(keys.lang, 'en')),
    };
}

export function setPulseIntensity(value) {
    const next = applyIntensity(value);
    storageSet(keys.intensity, next);
    return next;
}

export function setPulseTextScale(value) {
    const next = applyScale(value);
    storageSet(keys.textScale, next);
    return next;
}

export function setPulseLang(value) {
    const normalized = (typeof window !== 'undefined' && window.PulseI18n?.normalizeLang)
        ? window.PulseI18n.normalizeLang(value)
        : String(value || 'en');
    const next = applyLang(normalized);
    storageSet(keys.lang, next);
    notifyLangChange(next);
    return next;
}

export function bootPulsePrefs() {
    const state = getPulseState();
    notifyLangChange(state.lang);
    return state;
}
