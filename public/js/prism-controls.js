'use strict';

/**
 * Prism UI display controls — intensity / text scale / language.
 * Client-side only (localStorage via PulseBoot). No Pulse backend required.
 */
(function (global) {
    function syncPrismProfileControls() {
        const state = global.PulseBoot?.getState ? global.PulseBoot.getState() : null;
        if (!state) return;
        document.querySelectorAll('[data-pulse-intensity]').forEach((btn) => {
            btn.classList.toggle('pulse-opt-active', btn.getAttribute('data-pulse-intensity') === state.intensity);
        });
        document.querySelectorAll('[data-pulse-scale]').forEach((btn) => {
            btn.classList.toggle('pulse-opt-active', btn.getAttribute('data-pulse-scale') === state.textScale);
        });
        document.querySelectorAll('[data-pulse-lang]').forEach((btn) => {
            btn.classList.toggle('pulse-opt-active', btn.getAttribute('data-pulse-lang') === state.lang);
        });
    }

    global.syncPrismProfileControls = syncPrismProfileControls;
    global.syncPulseProfileControls = syncPrismProfileControls;

    global.handleSetPulseIntensity = (value) => {
        global.PulseBoot?.setIntensity(value);
        syncPrismProfileControls();
    };
    global.handleSetPulseTextScale = (value) => {
        global.PulseBoot?.setTextScale(value);
        syncPrismProfileControls();
    };
    global.handleSetPulseLang = (value) => {
        global.PulseBoot?.setLang(value);
        syncPrismProfileControls();
    };

    function boot() {
        syncPrismProfileControls();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot, { once: true });
    } else {
        boot();
    }
}(typeof window !== 'undefined' ? window : global));
