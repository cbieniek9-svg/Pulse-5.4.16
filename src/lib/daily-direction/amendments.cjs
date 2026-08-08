'use strict';

const crypto = require('crypto');
const { parseJson, nowIso } = require('./helpers.cjs');

const AMENDMENT_SNOOZE_MINUTES = 120;

function fingerprintTriggers(triggers) {
    const ids = (triggers || []).map((t) => t.id).sort().join('|');
    return crypto.createHash('sha256').update(ids).digest('hex').slice(0, 16);
}

function formatStoreTimeLabel(clock) {
    const t = String(clock?.storeTime || '').trim();
    if (t) return t;
    try {
        return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    } catch (_) {
        return '';
    }
}

function buildAmendmentTriggers({
    postedSnapshot,
    liveRisks,
    kpis,
    openTasks,
    settings,
}) {
    const triggers = [];
    const seen = new Set();
    const postedIds = new Set((postedSnapshot?.system_risks || []).map((r) => r.id));
    const postedAt = postedSnapshot?.posted_at ? Date.parse(postedSnapshot.posted_at) : null;

    const push = (trigger) => {
        if (!trigger?.id || seen.has(trigger.id)) return;
        seen.add(trigger.id);
        triggers.push(trigger);
    };

    (liveRisks || []).filter((r) => r.kind === 'pull' && r.severity === 'urgent').forEach((r) => {
        push({
            id: r.id,
            line: `Expiry pull still open: ${r.detail}`,
            severity: 'urgent',
            kind: r.kind,
        });
    });

    if (kpis?.shift_active) {
        const pph = Number(kpis.shift_pph);
        const std = Number(kpis.shift_standard_pph || settings?.Cases_Per_Hour || 55);
        if (pph > 0 && pph < std * 0.85) {
            push({
                id: 'pph:below_target',
                line: `Order PPH below target (${pph} vs ${std})`,
                severity: 'warn',
                kind: 'pph',
            });
        }
    }

    (liveRisks || []).filter((r) => postedIds.has(r.id) && r.severity === 'urgent' && r.kind !== 'pull').forEach((r) => {
        push({
            id: `open:${r.id}`,
            line: `Still open from morning: ${r.detail}`,
            severity: 'urgent',
            kind: r.kind,
        });
    });

    (liveRisks || []).filter((r) => !postedIds.has(r.id) && r.severity === 'urgent').forEach((r) => {
        push({
            id: `new:${r.id}`,
            line: `New urgent item: ${r.detail}`,
            severity: 'urgent',
            kind: r.kind,
        });
    });

    (liveRisks || []).filter((r) => r.kind === 'pph').forEach((r) => {
        push({
            id: r.id,
            line: r.detail.includes('PPH') ? r.detail : `Order PPH below target — ${r.detail}`,
            severity: 'warn',
            kind: 'pph',
        });
    });

    (openTasks || [])
        .filter((t) => !String(t.task_id || '').startsWith('AUTO-PULL'))
        .filter((t) => t.priority === 'Urgent' || t.priority === 'High')
        .forEach((t) => {
            const submitted = t.time_submitted ? Date.parse(t.time_submitted) : null;
            const ageMins = submitted ? (Date.now() - submitted) / 60000 : null;
            const overdue = ageMins != null && ageMins >= 90;
            if (t.priority === 'High' && !overdue) return;
            const zone = t.zone || 'General';
            const detail = String(t.task_detail || '').slice(0, 60);
            push({
                id: `task:${t.task_id}`,
                line: overdue
                    ? `${zone} task overdue: ${detail}`
                    : `${zone} ${t.priority} task still open: ${detail}`,
                severity: t.priority === 'Urgent' ? 'urgent' : 'warn',
                kind: 'task',
            });
        });

    (liveRisks || []).filter((r) => r.kind === 'zone' && r.severity === 'warn').slice(0, 2).forEach((r) => {
        push({
            id: r.id,
            line: `Cold zone — no recent audit: ${r.detail}`,
            severity: 'warn',
            kind: 'zone',
        });
    });

    return triggers.sort((a, b) => {
        const sev = { urgent: 0, warn: 1, info: 2 };
        return (sev[a.severity] ?? 9) - (sev[b.severity] ?? 9);
    });
}

function buildDefaultShiftUpdateMessage(triggers, clock) {
    const timeLabel = formatStoreTimeLabel(clock);
    const lines = [`SHIFT UPDATE${timeLabel ? ` — ${timeLabel}` : ''}`];
    (triggers || []).slice(0, 6).forEach((t) => lines.push(`• ${t.line}`));
    if (lines.length === 1) lines.push('• Review priorities — conditions changed since opening.');
    return lines.join('\n').slice(0, 500);
}

function buildAmendmentSuggestion(row, postedSnapshot, triggers, clock, shiftUpdateDraft) {
    if (!postedSnapshot?.posted_at || !triggers.length) return null;

    const fingerprint = fingerprintTriggers(triggers);
    const snoozedUntil = row?.amendment_snoozed_until ? Date.parse(row.amendment_snoozed_until) : null;
    if (snoozedUntil && snoozedUntil > Date.now()) return null;

    const dismissedFp = String(row?.amendment_dismissed_fingerprint || '');
    if (dismissedFp && dismissedFp === fingerprint) return null;

    const draftMsg = parseJson(shiftUpdateDraft, null)?.message;
    const suggestedMessage = draftMsg || buildDefaultShiftUpdateMessage(triggers, clock);

    return {
        fingerprint,
        headline: 'Daily Direction may need updating',
        summary: triggers.slice(0, 4).map((t) => t.line).join('; '),
        triggers: triggers.slice(0, 8),
        suggested_message: suggestedMessage,
        suggested_at: nowIso(),
    };
}

function buildCheckpointSuggestion(postedSnapshot, liveRisks) {
    const triggers = buildAmendmentTriggers({
        postedSnapshot,
        liveRisks,
        kpis: {},
        openTasks: [],
        settings: {},
    });
    if (!triggers.length) return null;
    return {
        suggested_at: nowIso(),
        summary: triggers.map((t) => t.line).join('; '),
        items: triggers.map((t) => t.line),
        still_open_risks: triggers.filter((t) => t.severity === 'urgent').slice(0, 5),
        new_urgent_risks: triggers.filter((t) => String(t.id).startsWith('new:')).slice(0, 5),
    };
}

module.exports = {
    AMENDMENT_SNOOZE_MINUTES,
    fingerprintTriggers,
    formatStoreTimeLabel,
    buildAmendmentTriggers,
    buildDefaultShiftUpdateMessage,
    buildAmendmentSuggestion,
    buildCheckpointSuggestion,
};
