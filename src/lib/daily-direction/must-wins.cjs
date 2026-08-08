'use strict';

const {
    riskId,
    parseJson,
    nowIso,
    loadDailyDirectionRow,
    normalizeMustWin,
} = require('./helpers.cjs');

function suggestMustWins(risks, settings, max = 3) {
    let owners = {};
    try { owners = JSON.parse(settings?.Zone_Ownership || '{}'); } catch (_) { /* ignore */ }

    const ranked = [...(risks || [])].sort((a, b) => {
        const sev = { urgent: 0, warn: 1, info: 2 };
        return (sev[a.severity] ?? 9) - (sev[b.severity] ?? 9);
    });

    return ranked.slice(0, max).map((r) => {
        let owner = r.owner_hint || '';
        if (!owner && r.detail) {
            const zoneMatch = String(r.detail).match(/^(Zone \d+)/i);
            if (zoneMatch && owners[zoneMatch[1]]) owner = owners[zoneMatch[1]];
        }
        return {
            text: owner ? `${owner}: ${r.detail}` : r.detail,
            owner: owner || '',
            source_risk_id: r.id,
            task_id: r.task_id ? String(r.task_id) : '',
        };
    });
}

function taskIdFromMustWin(win) {
    if (win?.task_id) return String(win.task_id);
    const key = String(win?.item_key || '');
    if (key.startsWith('task:')) return key.slice(5);
    const sid = String(win?.source_risk_id || '');
    // Legacy: source may be "task:Zone: detail" (riskId) — not a task_id.
    return '';
}

function mustWinsFingerprint(wins) {
    return (wins || []).map((w) => `${w.task_id || ''}|${w.text || ''}|${w.owner || ''}`).join('\n');
}

/** Replace Must-win block in floor message when present; leave custom text alone otherwise. */
function rewriteFloorMessageMustWins(message, mustWins) {
    const text = String(message || '');
    if (!/Must-win/i.test(text)) return text;
    const lines = text.split(/\r?\n/);
    const out = [];
    let i = 0;
    while (i < lines.length) {
        const trimmed = lines[i].trim();
        if (/^Must-win:?/i.test(trimmed)) {
            i += 1;
            while (i < lines.length && /^[•\-\*]\s/.test(lines[i].trim())) i += 1;
            continue;
        }
        out.push(lines[i]);
        i += 1;
    }
    const wins = (mustWins || []).filter((w) => w.text).slice(0, 3);
    if (wins.length) {
        out.push('Must-win:');
        wins.forEach((w) => out.push(`• ${w.text}`));
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Keep top-3 aligned with open Urgent/High board tasks.
 * Board-derived wins fill first; non-task manual wins keep leftover slots.
 */
function reconcileMustWinsFromBoard(prevWins, boardRisks, settings, max = 3) {
    const fromBoard = suggestMustWins(boardRisks, settings, max);
    if (fromBoard.length >= max) return fromBoard;

    const openDetails = new Set(boardRisks.map((r) => String(r.detail || '')));
    const usedText = new Set(fromBoard.map((w) => w.text));
    const manuals = [];
    (prevWins || []).map(normalizeMustWin).forEach((w) => {
        if (!w.text || manuals.length + fromBoard.length >= max) return;
        const tid = taskIdFromMustWin(w);
        if (tid) return; // closed/missing board tasks already dropped
        const sid = String(w.source_risk_id || '');
        if (sid.startsWith('task:')) {
            const riskDetail = sid.slice(5);
            if (!openDetails.has(riskDetail)) return; // task risk no longer open
            return; // still open — already in fromBoard
        }
        if (usedText.has(w.text)) return;
        manuals.push(w);
        usedText.add(w.text);
    });
    return [...fromBoard, ...manuals].slice(0, max);
}

/**
 * Re-read open Urgent/High tasks and refresh Daily Direction must-wins (draft + posted).
 * Returns { must_wins, changed } or null when nothing to do.
 */
function syncMustWinsWithOpenBoard(db, storeDate, opts = {}) {
    const row = loadDailyDirectionRow(db, storeDate);
    if (!row) return null;

    let openTasks = [];
    try {
        openTasks = db.all(`
            SELECT task_id, priority, zone, task_detail, assigned_to
            FROM tasks
            WHERE status = 'Open'
              AND (priority = 'Urgent' OR priority = 'High')
              AND task_id NOT LIKE 'AUTO-PULL%'
            ORDER BY CASE priority WHEN 'Urgent' THEN 0 ELSE 1 END, time_submitted ASC
        `) || [];
    } catch (_) {
        openTasks = [];
    }

    const boardRisks = openTasks.map((t) => {
        const detail = `${t.zone || ''}: ${String(t.task_detail || '').slice(0, 80)}`;
        const risk = {
            kind: 'task',
            severity: 'urgent',
            title: `${t.priority} TASK`,
            detail,
            meta: t.assigned_to || 'Unassigned',
            owner_hint: t.assigned_to && t.assigned_to !== 'Unassigned' ? t.assigned_to : '',
            task_id: String(t.task_id),
            item_key: `task:${t.task_id}`,
        };
        return { ...risk, id: riskId(risk) };
    });

    const settings = opts.settings || (typeof db.getSettings === 'function' ? db.getSettings() : {}) || {};
    const prev = (() => {
        if (row.posted_at) {
            const snap = parseJson(row.posted_snapshot_json, {});
            if (Array.isArray(snap.must_wins) && snap.must_wins.length) {
                return snap.must_wins.map(normalizeMustWin).filter((w) => w.text);
            }
        }
        return parseJson(row.must_wins_json, []).map(normalizeMustWin).filter((w) => w.text);
    })();

    const next = reconcileMustWinsFromBoard(prev, boardRisks, settings, 3);
    if (mustWinsFingerprint(prev) === mustWinsFingerprint(next)) return null;

    const actor = String(opts.actorName || 'system');
    const at = nowIso();
    const mustWinsJson = JSON.stringify(next);
    let floorMessage = String(row.floor_message || '');
    const rewritten = rewriteFloorMessageMustWins(floorMessage, next);
    if (rewritten !== floorMessage) floorMessage = rewritten;

    if (row.posted_at) {
        const snap = parseJson(row.posted_snapshot_json, {});
        snap.must_wins = next;
        if (rewritten) snap.floor_message = floorMessage;
        db.run(`
            UPDATE daily_direction SET
                must_wins_json = ?,
                floor_message = ?,
                posted_snapshot_json = ?,
                updated_at = ?,
                updated_by = ?
            WHERE store_date = ?
        `, mustWinsJson, floorMessage, JSON.stringify(snap), at, actor, storeDate);
    } else {
        db.run(`
            UPDATE daily_direction SET
                must_wins_json = ?,
                floor_message = ?,
                updated_at = ?,
                updated_by = ?
            WHERE store_date = ?
        `, mustWinsJson, floorMessage, at, actor, storeDate);
    }

    return { must_wins: next, changed: true, store_date: storeDate };
}

function buildDefaultFloorMessage({
    status,
    weekday,
    isOrderDay,
    mustWins,
    vendors,
}) {
    const dayLabel = [weekday, isOrderDay ? 'TGP Order Day' : 'Non-TGP Day'].filter(Boolean).join(' · ');
    const lines = [`TODAY: ${String(status || 'yellow').toUpperCase()}${dayLabel ? ` (${dayLabel})` : ''}`];
    if (vendors?.length) {
        lines.push(`Vendors: ${vendors.map((v) => v.vendor || v).join(', ')}`);
    }
    const wins = (mustWins || []).filter((w) => w.text).slice(0, 3);
    if (wins.length) {
        lines.push('Must-win:');
        wins.forEach((w) => lines.push(`• ${w.text}`));
    } else {
        lines.push('Must-win: Confirm priorities after store walk.');
    }
    return lines.join('\n').slice(0, 500);
}

module.exports = {
    suggestMustWins,
    taskIdFromMustWin,
    mustWinsFingerprint,
    rewriteFloorMessageMustWins,
    reconcileMustWinsFromBoard,
    syncMustWinsWithOpenBoard,
    buildDefaultFloorMessage,
};
