'use strict';

const crypto = require('crypto');
const { normalizeDevicePurpose } = require('./device-access-policy.cjs');

const DEVICE_TOKEN_PREFIX = 'tgpdt_';
const DEVICE_TOKEN_BYTES = 32;
const DEVICE_TOKEN_VALUE_LENGTH = 43;
const DEVICE_TOKEN_PATTERN = new RegExp(
    `^${DEVICE_TOKEN_PREFIX}[A-Za-z0-9_-]{${DEVICE_TOKEN_VALUE_LENGTH}}$`,
);

function nowIso() {
    return new Date().toISOString();
}

function createDeviceToken() {
    return DEVICE_TOKEN_PREFIX + crypto.randomBytes(DEVICE_TOKEN_BYTES).toString('base64url');
}

function normalizeDeviceToken(token) {
    if (typeof token !== 'string' || !DEVICE_TOKEN_PATTERN.test(token)) return '';
    return token;
}

function hashDeviceToken(token) {
    const normalized = normalizeDeviceToken(token);
    if (!normalized) return '';
    return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex');
}

function requestIp(req) {
    return req?.ip || req?.socket?.remoteAddress || req?.connection?.remoteAddress || 'unknown';
}

function readDeviceTokenInput(req) {
    const headers = req?.headers;
    if (headers && Object.prototype.hasOwnProperty.call(headers, 'x-device-token')) {
        const header = headers['x-device-token'];
        return { presented: true, raw: Array.isArray(header) ? header[0] : header };
    }
    const body = req?.body;
    if (body && Object.prototype.hasOwnProperty.call(body, 'deviceToken')) {
        return { presented: true, raw: body.deviceToken };
    }
    if (body && Object.prototype.hasOwnProperty.call(body, 'device_token')) {
        return { presented: true, raw: body.device_token };
    }
    return { presented: false, raw: undefined };
}

function extractDeviceToken(req) {
    return normalizeDeviceToken(readDeviceTokenInput(req).raw);
}

function touchDevice(db, device, req, via) {
    if (!db || !device?.id) return;
    const seenAt = nowIso();
    const ip = requestIp(req);
    try {
        db.run('UPDATE trusted_devices SET last_seen=?, last_seen_at=? WHERE id=?', seenAt, seenAt, device.id);
    } catch (_) { /* best effort */ }
    // Only update IP for token-authenticated devices when it is safe. Duplicate IP rows can exist as Pending
    // discovery records, so this must never break the auth path.
    if (via === 'token' && ip && ip !== 'unknown' && ip !== device.ip_address) {
        try {
            db.run('UPDATE trusted_devices SET ip_address=? WHERE id=?', ip, device.id);
        } catch (_) { /* keep existing IP if UNIQUE would fail */ }
    }
}

function findAuthorizedTrustedDevice(db, req, options = {}) {
    const tokenInput = readDeviceTokenInput(req);
    const token = extractDeviceToken(req);
    if (!tokenInput.presented) {
        return {
            authorized: false,
            device: null,
            via: null,
            reason: 'missing_token',
            code: 'DEVICE_TOKEN_REQUIRED',
        };
    }
    if (!token) {
        return {
            authorized: false,
            device: null,
            via: 'token',
            reason: 'invalid_token',
            code: 'INVALID_DEVICE_TOKEN',
        };
    }

    const hash = hashDeviceToken(token);
    const row = db.get(
        `SELECT id, ip_address, label, status, last_seen, last_seen_at,
                token_created_at, device_purpose, 1 AS has_device_token
           FROM trusted_devices
          WHERE device_token_hash=? AND status='Authorized'`,
        hash,
    );
    if (!row) {
        return {
            authorized: false,
            device: null,
            via: 'token',
            reason: 'invalid_token',
            code: 'INVALID_DEVICE_TOKEN',
        };
    }
    const dev = sanitizeTrustedDevice(row);

    const devicePurpose = normalizeDevicePurpose(dev.device_purpose);
    const purposeRequired = Object.prototype.hasOwnProperty.call(options, 'requiredPurpose');
    const requiredPurpose = purposeRequired ? normalizeDevicePurpose(options.requiredPurpose) : '';
    if (!devicePurpose || (purposeRequired && (!requiredPurpose || devicePurpose !== requiredPurpose))) {
        return {
            authorized: false,
            device: dev,
            via: 'token',
            reason: 'wrong_purpose',
            code: 'DEVICE_CAPABILITY_FORBIDDEN',
        };
    }

    touchDevice(db, dev, req, 'token');
    return { authorized: true, device: dev, via: 'token' };
}

function deviceChangedRetryError() {
    const error = new Error('Device changed; refresh and try again.');
    error.code = 'DEVICE_CHANGED_RETRY';
    error.status = 409;
    return error;
}

function snapshotMatches(existing, expectedSnapshot) {
    if (!expectedSnapshot) return true;
    return existing.status === expectedSnapshot.status
        && (existing.device_purpose ?? '') === (expectedSnapshot.devicePurpose ?? '')
        && (existing.device_token_hash ?? null) === (expectedSnapshot.deviceTokenHash ?? null);
}

function issueDeviceTokenForDevice(db, deviceId, {
    label,
    purpose: requestedPurpose,
    expectedSnapshot,
} = {}) {
    const id = Number.parseInt(String(deviceId), 10);
    if (!Number.isInteger(id) || id < 1) throw new Error('Invalid device id.');
    if (typeof db?.transaction !== 'function') throw new Error('Device token issuance requires a database transaction.');

    return db.transaction(() => {
        const existing = db.get(
            'SELECT id, status, device_purpose, device_token_hash FROM trusted_devices WHERE id=?',
            id,
        );
        if (!existing) throw new Error('Device not found.');
        if (!snapshotMatches(existing, expectedSnapshot)) throw deviceChangedRetryError();

        const existingStatus = existing.status ?? null;
        // Keep raw NULL for optimistic WHERE matching; coalesce only for input defaults.
        const existingPurposeRaw = existing.device_purpose;
        const existingPurpose = existing.device_purpose ?? '';
        const existingHash = existing.device_token_hash ?? null;
        const purpose = normalizeDevicePurpose(
            requestedPurpose === undefined ? existingPurpose : requestedPurpose,
        );
        if (!purpose) throw new Error('A valid device purpose is required.');

        const token = createDeviceToken();
        const hash = hashDeviceToken(token);
        const ts = nowIso();
        let update;
        if (label != null && String(label).trim()) {
            update = db.run(
                `UPDATE trusted_devices
                    SET status=?, label=?, device_purpose=?, device_token_hash=?,
                        token_created_at=?, last_seen_at=COALESCE(last_seen_at, ?)
                  WHERE id=? AND status IS ? AND device_purpose IS ? AND device_token_hash IS ?`,
                'Authorized',
                String(label).trim().slice(0, 120),
                purpose,
                hash,
                ts,
                ts,
                id,
                existingStatus,
                existingPurposeRaw,
                existingHash,
            );
        } else {
            update = db.run(
                `UPDATE trusted_devices
                    SET status=?, device_purpose=?, device_token_hash=?,
                        token_created_at=?, last_seen_at=COALESCE(last_seen_at, ?)
                  WHERE id=? AND status IS ? AND device_purpose IS ? AND device_token_hash IS ?`,
                'Authorized',
                purpose,
                hash,
                ts,
                ts,
                id,
                existingStatus,
                existingPurposeRaw,
                existingHash,
            );
        }
        if (update?.changes !== 1) {
            throw deviceChangedRetryError();
        }
        return { deviceToken: token, tokenCreatedAt: ts, devicePurpose: purpose };
    })();
}

function revokeDeviceToken(db, deviceId, { expectedSnapshot } = {}) {
    const id = Number.parseInt(String(deviceId), 10);
    if (!Number.isInteger(id) || id < 1) throw new Error('Invalid device id.');
    if (typeof db?.transaction !== 'function') throw new Error('Device token revocation requires a database transaction.');

    return db.transaction(() => {
        const existing = db.get(
            'SELECT id, status, device_purpose, device_token_hash FROM trusted_devices WHERE id=?',
            id,
        );
        if (!existing) throw new Error('Device not found.');
        if (!snapshotMatches(existing, expectedSnapshot)) throw deviceChangedRetryError();
        if (!existing.device_token_hash) return { changes: 0, alreadyRevoked: true };

        const update = db.run(
            `UPDATE trusted_devices
                SET device_token_hash=NULL, token_created_at=NULL
              WHERE id=? AND status IS ? AND device_purpose IS ? AND device_token_hash=?`,
            id,
            existing.status ?? null,
            existing.device_purpose,
            existing.device_token_hash,
        );
        if (update?.changes !== 1) {
            throw deviceChangedRetryError();
        }
        return { changes: 1, alreadyRevoked: false };
    })();
}

function sanitizeTrustedDevice(row) {
    if (!row) return null;
    return {
        id: row.id,
        ip_address: row.ip_address ?? null,
        label: row.label ?? null,
        status: row.status ?? null,
        last_seen: row.last_seen ?? null,
        last_seen_at: row.last_seen_at ?? null,
        token_created_at: row.token_created_at ?? null,
        device_purpose: row.device_purpose ?? '',
        has_device_token: Boolean(row.has_device_token ?? row.device_token_hash),
    };
}

function deviceAuthorizationError(message, code) {
    const error = new Error(message);
    error.code = code;
    error.status = code === 'DEVICE_CAPABILITY_FORBIDDEN' ? 403 : 401;
    return error;
}

/**
 * Call inside the same database transaction as the protected mutation.
 * Re-hashing the request credential proves the originally presented token is
 * still current without carrying a token hash in the authorization result.
 */
function assertCurrentDeviceAuthorization(db, authorization, req, requiredPurpose) {
    const id = Number(authorization?.device?.id);
    if (!authorization?.authorized || !Number.isInteger(id) || id < 1) {
        throw deviceAuthorizationError('Device authorization is no longer valid.', 'INVALID_DEVICE_TOKEN');
    }

    const token = extractDeviceToken(req);
    if (!token) {
        throw deviceAuthorizationError('Device authorization is no longer valid.', 'INVALID_DEVICE_TOKEN');
    }

    const expectedPurpose = normalizeDevicePurpose(
        requiredPurpose === undefined
            ? authorization.device.device_purpose
            : requiredPurpose,
    );
    if (!expectedPurpose) {
        throw deviceAuthorizationError('Device purpose is not permitted.', 'DEVICE_CAPABILITY_FORBIDDEN');
    }

    const current = db.get(
        `SELECT id, status, device_purpose,
                1 AS has_device_token
           FROM trusted_devices
          WHERE id=? AND device_token_hash=? AND status='Authorized'`,
        id,
        hashDeviceToken(token),
    );
    if (!current) {
        throw deviceAuthorizationError('Device authorization is no longer valid.', 'INVALID_DEVICE_TOKEN');
    }
    if (normalizeDevicePurpose(current.device_purpose) !== expectedPurpose) {
        throw deviceAuthorizationError('Device purpose is not permitted.', 'DEVICE_CAPABILITY_FORBIDDEN');
    }
    return sanitizeTrustedDevice(current);
}

function listTrustedDevicesSafe(db) {
    return db.all('SELECT * FROM trusted_devices ORDER BY last_seen DESC')
        .map(sanitizeTrustedDevice);
}

module.exports = {
    DEVICE_TOKEN_PREFIX,
    createDeviceToken,
    normalizeDeviceToken,
    hashDeviceToken,
    extractDeviceToken,
    findAuthorizedTrustedDevice,
    issueDeviceTokenForDevice,
    revokeDeviceToken,
    sanitizeTrustedDevice,
    assertCurrentDeviceAuthorization,
    listTrustedDevicesSafe,
    requestIp,
};
