'use strict';

const ACK_SETTING = 'Manager_Action_Acks';
const DEFER_SETTING = 'Rhythm_Deferred';
const DEFER_LOG_SETTING = 'Rhythm_Defer_Log';

function parseJsonSetting(raw, fallback) {
    try {
        return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
        return fallback;
    }
}

/** Parse Rhythm_Deferred; throw on corrupt / invalid shape (fail-closed for seed). */
function parseRhythmDeferralMap(raw) {
    if (raw == null || String(raw).trim() === '') return {};
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch (e) {
        const err = new Error('Rhythm_Deferred setting is corrupt JSON');
        err.cause = e;
        err.status = 500;
        throw err;
    }
    if (parsed == null || typeof parsed !== 'object' || Array.isArray(parsed)) {
        const err = new Error('Rhythm_Deferred setting has invalid shape (expected object)');
        err.status = 500;
        throw err;
    }
    return parsed;
}

function loadActionAcks(db) {
    try {
        const row = db.get('SELECT setting_value FROM settings WHERE setting_name=?', ACK_SETTING);
        return parseJsonSetting(row?.setting_value, []);
    } catch (_) {
        return [];
    }
}

function saveActionAcks(db, acks) {
    const trimmed = (acks || []).slice(-200);
    db.run(
        'INSERT OR REPLACE INTO settings (setting_name, setting_value) VALUES (?, ?)',
        ACK_SETTING,
        JSON.stringify(trimmed),
    );
}

function loadRhythmDeferrals(db) {
    const row = db.get('SELECT setting_value FROM settings WHERE setting_name=?', DEFER_SETTING);
    return parseRhythmDeferralMap(row?.setting_value);
}

function getDeferredRhythmIds(db, storeDate) {
    const map = loadRhythmDeferrals(db);
    return Array.isArray(map[storeDate]) ? map[storeDate] : [];
}

function setRhythmDeferrals(db, storeDate, rhythmIds) {
    let map = {};
    try {
        map = loadRhythmDeferrals(db);
    } catch (_) {
        // Corrupt map — overwrite with a fresh object for this write.
        map = {};
    }
    map[storeDate] = [...new Set((rhythmIds || []).map(String))];
    db.run(
        'INSERT OR REPLACE INTO settings (setting_name, setting_value) VALUES (?, ?)',
        DEFER_SETTING,
        JSON.stringify(map),
    );
    return map[storeDate];
}

function loadRhythmDeferLog(db) {
    try {
        const row = db.get('SELECT setting_value FROM settings WHERE setting_name=?', DEFER_LOG_SETTING);
        return parseJsonSetting(row?.setting_value, []);
    } catch (_) {
        return [];
    }
}

function saveRhythmDeferLog(db, entries) {
    const trimmed = (entries || []).slice(-300);
    db.run(
        'INSERT OR REPLACE INTO settings (setting_name, setting_value) VALUES (?, ?)',
        DEFER_LOG_SETTING,
        JSON.stringify(trimmed),
    );
    return trimmed;
}

function appendRhythmDeferLog(db, entry) {
    const log = loadRhythmDeferLog(db);
    log.push({
        store_date: entry.store_date || '',
        deferred_at: entry.deferred_at || new Date().toISOString(),
        deferred_by: entry.deferred_by || '',
        rhythm_ids: [...new Set((entry.rhythm_ids || []).map(String))],
        templates: (entry.templates || []).map(String),
        closed_board_tasks: Number(entry.closed_board_tasks || 0),
    });
    return saveRhythmDeferLog(db, log);
}

module.exports = {
    ACK_SETTING,
    DEFER_SETTING,
    DEFER_LOG_SETTING,
    parseJsonSetting,
    parseRhythmDeferralMap,
    loadActionAcks,
    saveActionAcks,
    loadRhythmDeferrals,
    getDeferredRhythmIds,
    setRhythmDeferrals,
    loadRhythmDeferLog,
    saveRhythmDeferLog,
    appendRhythmDeferLog,
};
