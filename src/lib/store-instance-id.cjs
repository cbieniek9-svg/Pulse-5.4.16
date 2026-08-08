'use strict';

const crypto = require('crypto');
const { STORE_INSTANCE_ID_KEY } = require('../constants/store-meta.cjs');

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function readStoreInstanceId(db) {
    try {
        return db?.get?.('SELECT setting_value FROM settings WHERE setting_name=?', STORE_INSTANCE_ID_KEY)?.setting_value;
    } catch (_) {
        return undefined;
    }
}

function mintStoreInstanceId() {
    if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
    const buf = crypto.randomBytes(16);
    buf[6] = (buf[6] & 0x0f) | 0x40;
    buf[8] = (buf[8] & 0x3f) | 0x80;
    const hex = buf.toString('hex');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Ensure Store_Instance_Id exists and is a valid UUID. Idempotent.
 * Does not overwrite a valid existing value.
 * @returns {{ instanceId: string, created: boolean }}
 */
function ensureStoreInstanceId(db) {
    const existing = String(readStoreInstanceId(db) || '').trim();
    if (UUID_RE.test(existing)) {
        return { instanceId: existing, created: false };
    }
    const instanceId = mintStoreInstanceId();
    if (existing) {
        db.run(
            'UPDATE settings SET setting_value = ? WHERE setting_name = ?',
            instanceId,
            STORE_INSTANCE_ID_KEY,
        );
    } else {
        db.run(
            'INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES (?, ?)',
            STORE_INSTANCE_ID_KEY,
            instanceId,
        );
        const after = String(readStoreInstanceId(db) || '').trim();
        if (!UUID_RE.test(after)) {
            db.run(
                'UPDATE settings SET setting_value = ? WHERE setting_name = ?',
                instanceId,
                STORE_INSTANCE_ID_KEY,
            );
        } else if (after !== instanceId) {
            return { instanceId: after, created: false };
        }
    }
    return { instanceId: String(readStoreInstanceId(db) || instanceId).trim(), created: true };
}

module.exports = {
    STORE_INSTANCE_ID_KEY,
    UUID_RE,
    mintStoreInstanceId,
    ensureStoreInstanceId,
    readStoreInstanceId,
};
