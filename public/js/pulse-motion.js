(function () {
    "use strict";

    function prefersReduced() {
        try {
            return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
        } catch (_) {
            return false;
        }
    }

    function isHighContrast() {
        return document.body?.classList?.contains("pulse-intensity-highcontrast");
    }

    function bootStagger(root) {
        if (!root || prefersReduced() || isHighContrast()) return;
        root.classList.add("pulse-boot-stagger");
    }

    function pulseLive(el, on) {
        if (!el) return;
        if (prefersReduced() || isHighContrast() || !on) {
            el.classList.remove("pulse-live-glow");
            return;
        }
        el.classList.add("pulse-live-glow");
    }

    function enhanceShell() {
        const body = document.body;
        if (!body || !body.classList.contains("pulse-holo")) return;
        body.classList.add("pulse-bridge");
        const shell = document.querySelector("[data-pulse-bridge-shell]") || document.querySelector("main") || document.getElementById("app");
        if (shell) {
            shell.classList.add("pulse-bridge-shell");
            bootStagger(shell);
        }
        document.querySelectorAll("[data-pulse-live]").forEach((el) => pulseLive(el, true));
    }

    function init() {
        enhanceShell();
    }

    if (document.readyState === "loading") {
        document.addEventListener("DOMContentLoaded", init);
    } else {
        init();
    }

    window.PulseMotion = { bootStagger, pulseLive, enhanceShell };
})();
