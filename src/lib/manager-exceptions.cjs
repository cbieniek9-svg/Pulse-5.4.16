'use strict';

const { addDaysToDateStamp } = require('./store-time.cjs');
const { isHeatMapZoneCold } = require('./heat-map-utils.cjs');
const { WEEKDAY_NAMES, isCompleteOrderDay, buildOrderWeeklyScorecard, weekdayFromStoreDate } = require('./order-weekly-scorecard.cjs');
const { buildScheduleHealthExceptions } = require('./schedule-health.cjs');

function parseStoreTimeMinutes(timeStr) {
    const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function isRhythmLoadedToday(db, storeDate) {
    const row = db.get("SELECT setting_value FROM settings WHERE setting_name='Daily_Rhythm_Last_Loaded'");
    return row?.setting_value === storeDate;
}

function wasTgpOrderDay(db, weekdayName) {
    return !!db.get(
        "SELECT 1 FROM rhythm_tasks WHERE day=? AND detail='TGP Order' LIMIT 1",
        weekdayName || '',
    );
}

function missingFinishYesterday(db, storeDate, storeWeekday) {
    const yesterday = addDaysToDateStamp(storeDate, -1);
    const yWeekdayIndex = weekdayFromStoreDate(yesterday);
    const yWeekday = WEEKDAY_NAMES[yWeekdayIndex];
    if (!wasTgpOrderDay(db, yWeekday)) return null;

    const row = db.get('SELECT * FROM shift_order_history WHERE store_date = ?', yesterday);
    if (row && isCompleteOrderDay(row)) return null;

    return {
        kind: 'missing_finish',
        color: '#f44',
        title: 'MISSING FINISH YESTERDAY',
        detail: `No complete order archive for ${yesterday} (${yWeekday})`,
        meta: 'Run FINISH on every order day',
    };
}

function scorecardOutlierToday(db, storeDate, storeWeekday) {
    if (!wasTgpOrderDay(db, storeWeekday)) return null;
    const todayRow = db.get('SELECT * FROM shift_order_history WHERE store_date = ?', storeDate);
    if (!todayRow || !isCompleteOrderDay(todayRow)) return null;

    const history = db.all(`
        SELECT store_date, order_start, order_end, total_pieces, actual_order_minutes
        FROM shift_order_history ORDER BY store_date DESC LIMIT 90
    `).filter(isCompleteOrderDay);

    const scorecard = buildOrderWeeklyScorecard(history);
    const wd = scorecard.by_weekday.find((r) => r.weekday === storeWeekday);
    if (!wd?.avg_pieces) return null;

    const todayPieces = Number(todayRow.total_pieces || 0);
    const avg = Number(wd.avg_pieces);
    const delta = Math.abs(todayPieces - avg) / avg;
    if (delta <= 0.2) return null;

    const direction = todayPieces > avg ? 'above' : 'below';
    return {
        kind: 'scorecard_outlier',
        color: '#f90',
        title: 'SCORECARD OUTLIER TODAY',
        detail: `${todayPieces} pieces vs ${round1(avg)} weekday avg (${direction})`,
        meta: storeWeekday,
    };
}

function rhythmNotLoadedBy630(db, storeDate, storeTime, storeWeekday) {
    if (isRhythmLoadedToday(db, storeDate)) return null;
    const mins = parseStoreTimeMinutes(storeTime);
    if (mins == null || mins < 6 * 60 + 30) return null;

    return {
        kind: 'rhythm_not_loaded',
        color: '#8cf',
        title: 'RHYTHM NOT LOADED',
        detail: `Daily rhythm not loaded by 06:30 (${storeWeekday})`,
        meta: 'Auto-heal runs on sync and every 15 min until 11:00 — or tap Load Rhythm',
    };
}

function round1(v) {
    return Math.round(v * 10) / 10;
}

/**
 * Server-computed manager exception inbox (v2).
 * @param {object} p
 * @param {object} p.db
 * @param {string} p.storeDate
 * @param {string} p.storeWeekday
 * @param {string} p.storeTime — HH:MM store local
 * @param {object} p.kpis
 * @param {object[]} p.tasks
 * @param {object[]} p.kill_dates
 * @param {object} p.settings
 * @param {object} p.zoneHeatMap
 */
function buildManagerExceptions({
    db, storeDate, storeWeekday, storeTime, kpis, tasks, kill_dates, settings, zoneHeatMap,
    isLiveToday = true,
}) {
    const today = storeDate;
    const items = [];

    if (isLiveToday) {
        (tasks || []).filter((t) => !String(t.task_id || '').startsWith('AUTO-PULL'))
            .filter((t) => t.priority === 'Urgent' || t.priority === 'High')
            .forEach((t) => {
                items.push({
                    kind: 'task',
                    item_key: `task:${t.task_id}`,
                    color: '#f44',
                    title: `${t.priority} TASK`,
                    detail: `${t.zone}: ${String(t.task_detail || '').slice(0, 80)}`,
                    meta: t.assigned_to || 'Unassigned',
                });
            });

        (kill_dates || []).filter((k) => k.status === 'Active' && k.kill_date && k.kill_date <= today)
            .forEach((k) => {
                items.push({
                    kind: 'pull',
                    item_key: `pull:${k.id}`,
                    color: '#f44',
                    title: 'EXPIRY PULL TODAY',
                    detail: `${k.zone}: ${k.item}`,
                    meta: k.zone || '',
                });
            });

        const hwOnOrder = Number(kpis?.pieces_on_order || 0);
        if (hwOnOrder > 0) {
            items.push({
                kind: 'hw',
                color: '#0cf',
                title: 'HARDWARE ON ORDER',
                detail: `${hwOnOrder} pieces not arrived`,
                meta: 'Receiving',
            });
        }

        if (kpis?.shift_active) {
            const pph = kpis.shift_pph;
            const std = kpis.shift_standard_pph || 55;
            if (pph != null && pph < std * 0.85) {
                items.push({
                    kind: 'pph',
                    color: '#f90',
                    title: 'SHIFT PPH BELOW TARGET',
                    detail: `Live ${pph} vs standard ${std}`,
                    meta: `${kpis.shift_elapsed || ''} elapsed`,
                });
            }
        }

        let owners = {};
        try { owners = JSON.parse(settings?.Zone_Ownership || '{}'); } catch (_) { /* ignore */ }
        const heat = zoneHeatMap || {};
        const coldThreshold = 4 * 60 * 60 * 1000;
        const now = Date.now();
        Object.keys(owners).forEach((z) => {
            if (isHeatMapZoneCold(heat[z], now, coldThreshold)) {
                items.push({
                    kind: 'zone',
                    item_key: `zone:${z}`,
                    color: '#8cf',
                    title: 'COLD ZONE (NO RECENT AUDIT)',
                    detail: z,
                    meta: owners[z] || '',
                });
            }
        });
    }

    const v2 = [
        ...buildScheduleHealthExceptions(db, { storeDate, storeTime, settings }),
        missingFinishYesterday(db, storeDate, storeWeekday),
        scorecardOutlierToday(db, storeDate, storeWeekday),
        ...(isLiveToday ? [rhythmNotLoadedBy630(db, storeDate, storeTime, storeWeekday)] : []),
    ].filter(Boolean);

    return [...v2, ...items];
}

module.exports = { buildManagerExceptions, rhythmNotLoadedBy630, wasTgpOrderDay };
