'use strict';

const { upsertSetting } = require('./settings-store.cjs');

const SHADOW_MODE_SETTING = 'Financial_Log_Shadow_Mode';
const SHADOW_ALLOWLIST_SETTING = 'Financial_Log_Shadow_Allowlist';

function normalizeName(value) {
    return String(value || '').trim().toLowerCase();
}

function readShadowConfig(db) {
    const modeRow = db.get('SELECT setting_value FROM settings WHERE setting_name=?', SHADOW_MODE_SETTING);
    const listRow = db.get('SELECT setting_value FROM settings WHERE setting_name=?', SHADOW_ALLOWLIST_SETTING);
    const allowlist = String(listRow?.setting_value || '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
    return {
        shadow_mode: String(modeRow?.setting_value ?? '1') === '1',
        allowlist,
    };
}

function canAccessFinancialLog(db, actorName) {
    const cfg = readShadowConfig(db);
    if (!cfg.shadow_mode) return true;
    if (!cfg.allowlist.length) return false;
    const name = normalizeName(actorName);
    return cfg.allowlist.some((entry) => normalizeName(entry) === name);
}

function claimShadowAccess(db, actorName) {
    const cfg = readShadowConfig(db);
    if (!cfg.shadow_mode) {
        return { ...cfg, claimed: false, reason: 'Shadow mode is off.' };
    }
    if (cfg.allowlist.length) {
        const err = new Error('Shadow access is already assigned to another user.');
        err.status = 409;
        throw err;
    }
    const name = String(actorName || '').trim();
    if (!name) {
        const err = new Error('Staff name is required.');
        err.status = 400;
        throw err;
    }
    upsertSetting(db, SHADOW_ALLOWLIST_SETTING, name);
    return {
        shadow_mode: true,
        allowlist: [name],
        claimed: true,
    };
}

function buildAccessPayload(db, actorName) {
    const cfg = readShadowConfig(db);
    const canAccess = canAccessFinancialLog(db, actorName);
    return {
        shadow_mode: cfg.shadow_mode,
        allowlist: cfg.allowlist,
        can_access: canAccess,
        can_claim: cfg.shadow_mode && cfg.allowlist.length === 0,
    };
}

function normalizeAllowlistInput(value) {
    if (Array.isArray(value)) {
        return value.map((part) => String(part || '').trim()).filter(Boolean).join(', ');
    }
    return String(value || '')
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .join(', ');
}

function updateShadowSettings(db, { shadow_mode: shadowMode, allowlist } = {}) {
    const previous = readShadowConfig(db);
    if (shadowMode !== undefined) {
        upsertSetting(db, SHADOW_MODE_SETTING, shadowMode ? '1' : '0');
    }
    if (allowlist !== undefined) {
        upsertSetting(db, SHADOW_ALLOWLIST_SETTING, normalizeAllowlistInput(allowlist));
    }
    const current = readShadowConfig(db);
    return { previous, current };
}

module.exports = {
    SHADOW_MODE_SETTING,
    SHADOW_ALLOWLIST_SETTING,
    readShadowConfig,
    canAccessFinancialLog,
    claimShadowAccess,
    buildAccessPayload,
    updateShadowSettings,
};
