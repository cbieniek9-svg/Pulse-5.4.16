(function () {
    "use strict";

    const keys = {
        intensity: "tgp_pulse_intensity",
        textScale: "tgp_pulse_text_scale",
        lang: "tgp_pulse_lang",
    };
    const intensities = new Set(["", "bridge", "standard", "highcontrast", "dockglare"]);
    const scales = new Set(["", "normal", "large", "xl"]);
    let observingBody = false;

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
            if (value == null || value === "") localStorage.removeItem(key);
            else localStorage.setItem(key, value);
        } catch (_) {}
    }

    function normalizeIntensity(value) {
        const next = String(value || "bridge").toLowerCase();
        if (next === "standard" || next === "") return "bridge";
        return intensities.has(next) ? next : "bridge";
    }

    function normalizeScale(value) {
        const next = String(value || "normal").toLowerCase();
        return scales.has(next) ? next : "normal";
    }

    function ensureBody() {
        if (!document.body) return null;
        document.body.classList.add("pulse-holo");
        return document.body;
    }

    function applyIntensity(value) {
        const body = ensureBody();
        if (!body) return "bridge";
        const next = normalizeIntensity(value);
        body.classList.remove(
            "pulse-intensity-bridge",
            "pulse-intensity-highcontrast",
            "pulse-intensity-dockglare",
        );
        body.classList.add(`pulse-intensity-${next}`);
        body.dataset.pulseIntensity = next;
        return next;
    }

    function applyScale(value) {
        const next = normalizeScale(value);
        if (next === "large" || next === "xl") {
            document.documentElement.dataset.textScale = next;
        } else {
            delete document.documentElement.dataset.textScale;
        }
        return next;
    }

    function applyLang(value) {
        const lang = String(value || storageGet(keys.lang, document.documentElement.lang || "en"));
        if (window.PulseI18n?.apply) return window.PulseI18n.apply(lang);
        document.documentElement.lang = lang;
        return lang;
    }

    function enableScanlines() {
        const body = ensureBody();
        if (!body || body.dataset.pulseSurface !== "tv") return null;
        let overlay = document.getElementById("pulse-scanlines");
        if (!overlay) {
            overlay = document.createElement("div");
            overlay.id = "pulse-scanlines";
            overlay.setAttribute("aria-hidden", "true");
            body.appendChild(overlay);
        }
        return overlay;
    }

    function disableScanlines() {
        document.getElementById("pulse-scanlines")?.remove();
    }

    function getState() {
        return {
            intensity: normalizeIntensity(storageGet(keys.intensity, "bridge")),
            textScale: normalizeScale(storageGet(keys.textScale, "normal")),
            lang: storageGet(keys.lang, document.documentElement.lang || "en"),
            surface: document.body?.dataset?.pulseSurface || "",
        };
    }

    function apply(options) {
        const state = {
            ...getState(),
            ...(options || {}),
        };
        const applied = {
            intensity: applyIntensity(state.intensity),
            textScale: applyScale(state.textScale),
            lang: applyLang(state.lang),
        };
        if (document.body?.dataset?.pulseSurface === "tv") enableScanlines();
        return applied;
    }

    function setIntensity(value) {
        const next = normalizeIntensity(value);
        storageSet(keys.intensity, next === "bridge" ? "" : next);
        return applyIntensity(next);
    }

    function setTextScale(value) {
        const next = normalizeScale(value);
        storageSet(keys.textScale, next === "normal" ? "" : next);
        return applyScale(next);
    }

    function setLang(value) {
        const next = window.PulseI18n?.normalizeLang ? window.PulseI18n.normalizeLang(value) : String(value || "en");
        storageSet(keys.lang, next);
        return applyLang(next);
    }

    function boot() {
        const applied = apply(getState());
        watchBodyClassResets();
        return applied;
    }

    function watchBodyClassResets() {
        if (observingBody || !window.MutationObserver || !document.body) return;
        observingBody = true;
        const observer = new MutationObserver(() => {
            if (!document.body.classList.contains("pulse-holo")) {
                applyIntensity(storageGet(keys.intensity, "bridge"));
            }
        });
        observer.observe(document.body, { attributes: true, attributeFilter: ["class"] });
    }

    window.PulseBoot = {
        keys,
        boot,
        apply,
        getState,
        setIntensity,
        setTextScale,
        setLang,
        enableScanlines,
        disableScanlines,
    };

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", boot, { once: true });
    } else {
        boot();
    }
})();
