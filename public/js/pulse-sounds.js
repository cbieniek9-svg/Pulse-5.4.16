(function () {
    "use strict";

    const MUTE_KEY = "tgp_pulse_mute";
    const TV_SOUND_KEY = "tgp_pulse_tv_sound";
    let audioContext = null;

    function storageGet(key) {
        try {
            return localStorage.getItem(key);
        } catch (_) {
            return null;
        }
    }

    function isTvSurface() {
        return document.body?.dataset?.pulseSurface === "tv";
    }

    function canPlay() {
        if (storageGet(MUTE_KEY) === "1") return false;
        if (isTvSurface() && storageGet(TV_SOUND_KEY) !== "1") return false;
        return true;
    }

    function getContext() {
        if (audioContext) return audioContext;
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) return null;
        audioContext = new AudioCtor();
        return audioContext;
    }

    function tone(freq, start, duration, gainValue, type) {
        const ctx = getContext();
        if (!ctx) return;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = type || "sine";
        osc.frequency.setValueAtTime(freq, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(gainValue, start + 0.015);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + duration + 0.03);
    }

    function playPattern(pattern) {
        try {
            if (!canPlay()) return false;
            const ctx = getContext();
            if (!ctx) return false;
            if (ctx.state === "suspended") ctx.resume().catch(() => {});
            const base = ctx.currentTime + 0.02;
            pattern.forEach((note) => {
                tone(note.freq, base + note.at, note.duration, note.gain || 0.035, note.type);
            });
            return true;
        } catch (_) {
            return false;
        }
    }

    function playOrderIncoming() {
        return playPattern([
            { freq: 660, at: 0, duration: 0.08, type: "triangle" },
            { freq: 990, at: 0.09, duration: 0.1, type: "triangle" },
            { freq: 1320, at: 0.2, duration: 0.14, gain: 0.028, type: "sine" },
        ]);
    }

    function playPriorityClear() {
        return playPattern([
            { freq: 880, at: 0, duration: 0.07, type: "sine" },
            { freq: 704, at: 0.08, duration: 0.08, type: "sine" },
            { freq: 528, at: 0.17, duration: 0.16, gain: 0.026, type: "triangle" },
        ]);
    }

    function setMuted(muted) {
        try {
            localStorage.setItem(MUTE_KEY, muted ? "1" : "0");
        } catch (_) {}
    }

    window.PulseSounds = {
        playOrderIncoming,
        playPriorityClear,
        setMuted,
        isMuted: () => storageGet(MUTE_KEY) === "1",
    };
})();
