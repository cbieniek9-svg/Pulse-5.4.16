'use strict';

const { upsertShiftOrderHistory, upsertFrozenOrderHistory, resolveOrderStoreDate } = require('./order-history-archive.cjs');
const { computeArchivedOrderMetrics, parseHardwareArrived } = require('./shift-metrics.cjs');
const { loadPresenceConfig } = require('./presence-config.cjs');
const { buildPresenceFinishHint, snapshotOrderPresence } = require('./presence-engine.cjs');
const { upsertSetting } = require('./settings-store.cjs');

/**
 * Finish a live order clock.
 * @param {'dry'|'frozen'} [opts.clockKind='dry'] — dry uses Order_Start; frozen uses Frozen_Order_Start
 */
function executeOrderFinish(db, {
    staffCount,
    hardwareArrived,
    orderEnd,
    serverTime,
    getStoreDateStamp,
    staffRoster = null,
    exceptionReason = null,
    clockKind = 'dry',
}) {
    const kind = clockKind === 'frozen' ? 'frozen' : 'dry';
    const settings = db.getSettings ? db.getSettings() : {};
    const orderStart = kind === 'frozen'
        ? (settings.Frozen_Order_Start || '')
        : (settings.Order_Start || '');
    if (!orderStart) {
        const err = new Error(kind === 'frozen' ? 'Frozen order clock is not running.' : 'Dry order clock is not running.');
        err.status = 400;
        throw err;
    }

    let endIso = orderEnd || serverTime || new Date().toISOString();
    if (!Number.isFinite(Date.parse(endIso))) endIso = new Date().toISOString();
    if (Date.parse(endIso) < Date.parse(orderStart)) {
        endIso = orderStart;
    }

    const staff = Number(staffCount);
    if (!Number.isFinite(staff) || staff < 1 || staff > 99) {
        const err = new Error('staff_count must be 1-99.');
        err.status = 400;
        throw err;
    }

    const hwArrived = parseHardwareArrived(hardwareArrived);
    const counts = db.getCounts ? (db.getCounts() || {}) : {};
    const mergedCounts = { ...counts, staff };
    if (kind === 'frozen') mergedCounts.frozen_staff = staff;

    let archiveResult;
    const run = () => {
        if (kind === 'dry') {
            db.run('UPDATE counts SET staff = ? WHERE id = 1', staff);
            upsertSetting(db, 'Hardware_Arrived', hwArrived ? '1' : '0');
            upsertSetting(db, 'Order_End', endIso);

            const storeDate = resolveOrderStoreDate(orderStart, endIso, getStoreDateStamp);
            archiveResult = upsertShiftOrderHistory(db, {
                orderStart,
                orderEnd: endIso,
                recordedAt: serverTime || endIso,
                storeDate,
                settings: { ...settings, Hardware_Arrived: hwArrived ? '1' : '0', Order_End: endIso },
                counts: mergedCounts,
                staffCount: staff,
                staffRoster: Array.isArray(staffRoster) ? staffRoster : null,
                exceptionReason,
                clockKind: 'dry',
            });

            if (archiveResult.shiftTotalPph > 0) {
                upsertSetting(db, 'Last_Actual_PPH', String(Number(archiveResult.shiftTotalPph.toFixed(1))));
            }
            upsertSetting(db, 'Order_Start', '');
            upsertSetting(db, 'Order_End', '');
        } else {
            db.run('UPDATE counts SET frozen_staff = ? WHERE id = 1', staff);
            upsertSetting(db, 'Frozen_Order_End', endIso);

            const storeDate = resolveOrderStoreDate(orderStart, endIso, getStoreDateStamp);
            archiveResult = upsertFrozenOrderHistory(db, {
                frozenOrderStart: orderStart,
                frozenOrderEnd: endIso,
                recordedAt: serverTime || endIso,
                storeDate,
                settings,
                counts: mergedCounts,
                frozenStaffCount: staff,
                staffRoster: Array.isArray(staffRoster) ? staffRoster : null,
                exceptionReason,
            });

            upsertSetting(db, 'Frozen_Order_Start', '');
            upsertSetting(db, 'Frozen_Order_End', '');
        }
    };

    if (db.transaction) db.transaction(run)();
    else run();

    const presenceConfig = loadPresenceConfig(db);
    const storeDate = archiveResult.storeDate;
    let presenceSnapshot = null;
    let presenceFinish = { hint: null, mismatch: false, message: null };
    if (kind === 'dry' && presenceConfig.enabled) {
        presenceFinish = buildPresenceFinishHint(db, presenceConfig, staff);
        presenceSnapshot = snapshotOrderPresence(db, presenceConfig, {
            storeDate,
            orderStart,
        });
    }

    const mins = archiveResult.actualOrderMinutes || archiveResult.frozenActualMinutes || 0;
    const pieces = kind === 'frozen'
        ? Number(mergedCounts.frozen || 0)
        : Number(mergedCounts.grocery || 0) + (hwArrived ? Number(mergedCounts.hardware || 0) : 0);
    const metrics = computeArchivedOrderMetrics(pieces, mins, staff);

    return {
        clockKind: kind,
        storeDate: archiveResult.storeDate,
        teamPph: archiveResult.shiftTotalPph ?? archiveResult.frozenPph ?? metrics.team_pph,
        staffCount: staff,
        staffRoster: Array.isArray(staffRoster) ? staffRoster.filter(Boolean) : [],
        exceptionReason: exceptionReason == null ? '' : String(exceptionReason).trim().slice(0, 200),
        adjustedPerPersonPph: metrics.adjusted_per_person_pph,
        actualOrderMinutes: mins,
        hardwareArrived: kind === 'dry' ? hwArrived : false,
        presence_hint: presenceFinish.hint,
        presence_mismatch: presenceFinish.mismatch,
        presence_message: presenceFinish.message,
        presence_snapshot: presenceSnapshot,
    };
}

module.exports = { executeOrderFinish };
