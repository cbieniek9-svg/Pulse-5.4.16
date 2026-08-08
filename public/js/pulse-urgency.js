// Browser mirror of src/lib/pulse/urgency.cjs — used by TV + mobile task cards.
(function () {
    "use strict";

    function clamp01(n) {
        return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
    }

    function elapsedRatio(task, nowMs) {
        const now = Number.isFinite(nowMs) ? nowMs : Date.now();
        const startRaw = task?.start_time || task?.time_submitted;
        const startMs = Date.parse(startRaw);
        const start = Number.isFinite(startMs) ? startMs : now;
        const estMins = Math.max(1, Number(task?.est_mins) || 15);
        return (now - start) / (estMins * 60000);
    }

    function stageFromRatio(ratio) {
        const r = Number(ratio);
        if (!Number.isFinite(r)) return "soft";
        if (r >= 1) return "overdue";
        if (r >= 0.85) return "critical";
        if (r >= 0.5) return "warn";
        return "soft";
    }

    function stageFromTask(task, nowMs = Date.now()) {
        const ratio = elapsedRatio(task, nowMs);
        const stage = stageFromRatio(ratio);
        return {
            stage,
            ratio: clamp01(Math.min(ratio, 1)),
            className: `pulse-urgency-${stage}`,
        };
    }

    window.PulseUrgency = {
        elapsedRatio,
        stageFromRatio,
        stageFromTask,
    };
})();
