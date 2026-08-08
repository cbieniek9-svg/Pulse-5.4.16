'use strict';

const { buildManagerHubMeta } = require('./manager-hub-meta.cjs');
const { loadHeatMap } = require('../dal/heatmap.cjs');
const { loadPresenceConfig } = require('./presence-config.cjs');
const { ensureStaffNameAliasTable } = require('./staff-name-aliases.cjs');
const { ensureSafetySchema } = require('./safety-blurbs.cjs');
const { staffHasColumn } = require('./staff-permissions.cjs');
const { logInfo, logWarn, recordAppError } = require('./app-log.cjs');

function repairShiftLeadEligibleColumn(db) {
    if (staffHasColumn(db, 'shift_lead_eligible')) return false;
    db.exec('ALTER TABLE staff ADD COLUMN shift_lead_eligible INTEGER DEFAULT 1');
    db.run("UPDATE staff SET shift_lead_eligible = 0 WHERE role = 'Store Manager'");
    return true;
}

function repairManagerHubSchema(db) {
    const repairs = [];
    try {
        if (repairShiftLeadEligibleColumn(db)) repairs.push('added staff.shift_lead_eligible');
    } catch (err) {
        logWarn('boot/manager_hub', `shift_lead_eligible repair failed: ${err.message}`);
    }
    try {
        ensureStaffNameAliasTable(db);
    } catch (err) {
        logWarn('boot/manager_hub', `staff_name_aliases ensure failed: ${err.message}`);
    }
    try {
        ensureSafetySchema(db);
    } catch (err) {
        logWarn('boot/manager_hub', `safety schema ensure failed: ${err.message}`);
    }
    return repairs;
}

function probeManagerHubSync(db, deps = {}) {
    const {
        getStoreDateStamp,
        getStoreClockPayload,
        getSettings,
        cachedHeatMap,
    } = deps;
    const today = typeof getStoreDateStamp === 'function' ? getStoreDateStamp() : '';
    const clock = typeof getStoreClockPayload === 'function' ? getStoreClockPayload() : {};
    const settings = typeof getSettings === 'function' ? getSettings() : (db.getSettings?.() || {});
    const counts = db.getCounts?.() || { grocery: 0, frozen: 0, hardware: 0, staff: 1 };
    const cph = parseFloat(settings.Cases_Per_Hour) || 55;
    const g = counts.grocery || 0;
    const f = counts.frozen || 0;
    const staff = counts.staff || 1;
    const kpis = {
        g,
        f,
        staff,
        g_hrs: (g / cph).toFixed(1),
        f_hrs: (f / cph).toFixed(1),
        shift_active: false,
        pieces_on_order: 0,
    };
    const presenceConfig = loadPresenceConfig(db);
    const heatMap = cachedHeatMap || loadHeatMap(db);

    buildManagerHubMeta(db, {
        today,
        clock,
        kpis,
        settings,
        cachedHeatMap: heatMap,
        presenceConfig,
        getStoreDateStamp,
    });
    return { ok: true, storeDate: today };
}

/**
 * Boot-time manager sync path check: apply safe schema repairs, then probe buildManagerHubMeta.
 * Retries once after repairs so partial deploys self-heal on restart.
 */
function runManagerHubBootCheck(db, deps = {}) {
    const repairs = repairManagerHubSchema(db);
    repairs.forEach((r) => logInfo('boot/manager_hub', `repair applied: ${r}`, { storeDate: deps.getStoreDateStamp?.() }));

    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
            const result = probeManagerHubSync(db, deps);
            if (attempt > 1) {
                logInfo('boot/manager_hub', 'manager hub probe recovered after repair', result);
            }
            return {
                ok: true,
                status: 'ok',
                repairs,
                attempts: attempt,
                storeDate: result.storeDate,
            };
        } catch (err) {
            lastError = err;
            if (attempt === 1) {
                const extraRepairs = repairManagerHubSchema(db);
                extraRepairs.forEach((r) => logInfo('boot/manager_hub', `retry repair applied: ${r}`));
                repairs.push(...extraRepairs);
                continue;
            }
        }
    }

    const message = lastError?.message || 'Manager hub probe failed';
    recordAppError('boot/manager_hub', message, lastError, {
        storeDate: deps.getStoreDateStamp?.(),
        repairs,
    }, db);
    return {
        ok: false,
        status: 'error',
        repairs,
        attempts: 2,
        error: message,
        detail: lastError?.stack ? String(lastError.stack).split('\n').slice(0, 6).join('\n') : '',
    };
}

function persistManagerHubBootStatus(db, result) {
    if (!db || !result) return;
    try {
        db.run(
            'INSERT INTO settings (setting_name, setting_value) VALUES (?, ?) ON CONFLICT(setting_name) DO UPDATE SET setting_value=excluded.setting_value',
            'Manager_Hub_Boot_Status',
            JSON.stringify({
                checked_at: new Date().toISOString(),
                ok: !!result.ok,
                status: result.status || (result.ok ? 'ok' : 'error'),
                error: result.error || null,
                repairs: result.repairs || [],
                attempts: result.attempts || 1,
                storeDate: result.storeDate || null,
            }),
        );
    } catch (_) { /* ignore */ }
}

module.exports = {
    repairManagerHubSchema,
    probeManagerHubSync,
    runManagerHubBootCheck,
    persistManagerHubBootStatus,
};
