'use strict';

const { logManagerAudit } = require('../../lib/audit-log.cjs');
const { normalizeDevicePurpose } = require('../../lib/device-access-policy.cjs');
const {
    createDeviceToken,
    hashDeviceToken,
    issueDeviceTokenForDevice,
    revokeDeviceToken,
    sanitizeTrustedDevice,
} = require('../../lib/trusted-device-tokens.cjs');

const DEVICE_ERROR = Object.freeze({
    id: ['Device id is required.', 'DEVICE_ID_REQUIRED'],
    label: ['Device label is required.', 'DEVICE_LABEL_REQUIRED'],
    purpose: ['A valid device purpose is required.', 'DEVICE_PURPOSE_INVALID'],
    missing: ['Device not found.', 'DEVICE_NOT_FOUND'],
});

function readDeviceId(req, res, fail) {
    const raw = req.body?.id;
    const validNumber = typeof raw === 'number' && Number.isSafeInteger(raw) && raw > 0;
    const validString = typeof raw === 'string' && /^[1-9]\d*$/.test(raw);
    const id = validString ? Number(raw) : raw;
    if ((!validNumber && !validString) || !Number.isSafeInteger(id) || id < 1) {
        fail(res, 400, ...DEVICE_ERROR.id);
        return null;
    }
    return id;
}

function readLabel(req, res, fail) {
    const label = typeof req.body?.label === 'string' ? req.body.label.trim().slice(0, 120) : '';
    if (!label) {
        fail(res, 400, ...DEVICE_ERROR.label);
        return null;
    }
    return label;
}

function readPurpose(req, res, fail, fallback) {
    const requested = req.body && Object.prototype.hasOwnProperty.call(req.body, 'purpose')
        ? req.body.purpose
        : fallback;
    const purpose = normalizeDevicePurpose(requested);
    if (!purpose) {
        fail(res, 400, ...DEVICE_ERROR.purpose);
        return null;
    }
    return purpose;
}

function getDevice(db, id) {
    return db.get(
        `SELECT id, ip_address, label, status, last_seen, last_seen_at,
                token_created_at, device_purpose, device_token_hash
           FROM trusted_devices
          WHERE id=?`,
        id,
    );
}

function safeDevice(db, id) {
    return sanitizeTrustedDevice(getDevice(db, id));
}

function deviceSnapshot(device) {
    return {
        status: device.status ?? null,
        devicePurpose: device.device_purpose ?? '',
        deviceTokenHash: device.device_token_hash ?? null,
    };
}

function auditMetadata(device, {
    priorPurpose = device?.device_purpose || '',
    newPurpose = device?.device_purpose || '',
    outcome = 'success',
} = {}) {
    return {
        device_id: Number(device.id),
        label: device.label || null,
        prior_purpose: priorPurpose || '',
        new_purpose: newPurpose || '',
        outcome,
        ...(device.ip_address ? { ip_address: device.ip_address } : {}),
    };
}

function deviceAuditFailure() {
    const error = new Error('Device audit could not be recorded.');
    error.code = 'DEVICE_AUDIT_FAILED';
    return error;
}

function auditDevice(writeAudit, db, req, session, device, action, summary, purposes) {
    let written;
    try {
        written = writeAudit(db, {
            req,
            session,
            action,
            targetType: 'trusted_device',
            targetId: device.id,
            summary,
            metadata: auditMetadata(device, purposes),
        });
    } catch (_) {
        throw deviceAuditFailure();
    }
    if (written !== true) throw deviceAuditFailure();
}

function failDeviceMutation(res, fail, error, {
    status = 409,
    message = 'Device changed; refresh and try again.',
    code = 'DEVICE_CONFLICT',
} = {}) {
    if (error?.code === 'DEVICE_AUDIT_FAILED') {
        return fail(
            res,
            500,
            'Device audit could not be recorded. No changes were saved.',
            'DEVICE_AUDIT_FAILED',
        );
    }
    if (error?.code === 'DEVICE_CHANGED_RETRY') {
        return fail(res, 409, 'Device changed; refresh and try again.', 'DEVICE_CHANGED_RETRY');
    }
    return fail(res, status, message, code);
}

function oneTimeTokenResponse(res, device, issued) {
    res.setHeader('Cache-Control', 'no-store, private');
    res.setHeader('Pragma', 'no-cache');
    res.json({
        success: true,
        device,
        device_token: issued.deviceToken,
        token_created_at: issued.tokenCreatedAt,
        pairing_note: 'This token is shown once. Store it only on the intended device.',
    });
}

function registerDeviceRoutes(server, ctx) {
    const { wrap, fail, requireSession, db, broadcastUpdate } = ctx;
    const writeAudit = ctx.logManagerAudit || logManagerAudit;

    server.post('/api/devices/create', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const label = readLabel(req, res, fail);
        if (!label) return;
        const purpose = readPurpose(req, res, fail);
        if (!purpose) return;

        let result;
        try {
            result = db.transaction(() => {
                const deviceToken = createDeviceToken();
                const tokenCreatedAt = new Date().toISOString();
                const inserted = db.run(
                    `INSERT INTO trusted_devices (
                        ip_address, label, status, last_seen, last_seen_at,
                        device_token_hash, token_created_at, device_purpose
                    ) VALUES (NULL, ?, 'Authorized', NULL, ?, ?, ?, ?)`,
                    label,
                    tokenCreatedAt,
                    hashDeviceToken(deviceToken),
                    tokenCreatedAt,
                    purpose,
                );
                const issued = {
                    id: Number(inserted.lastInsertRowid),
                    deviceToken,
                    tokenCreatedAt,
                };
                const device = safeDevice(db, issued.id);
                const purposes = { priorPurpose: '', newPurpose: purpose };
                auditDevice(writeAudit, db, req, session, device, 'trusted_device_created', `Created device ${label}`, purposes);
                auditDevice(writeAudit, db, req, session, device, 'trusted_device_token_issued', `Issued device token for ${label}`, purposes);
                return { issued, device };
            })();
        } catch (error) {
            return failDeviceMutation(res, fail, error, {
                status: 500,
                message: 'Device operation failed.',
                code: 'DEVICE_OPERATION_FAILED',
            });
        }
        broadcastUpdate();
        oneTimeTokenResponse(res, result.device, result.issued);
    }));

    server.post('/api/devices/authorize', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const id = readDeviceId(req, res, fail);
        if (!id) return;
        const label = readLabel(req, res, fail);
        if (!label) return;
        const purpose = readPurpose(req, res, fail);
        if (!purpose) return;
        const before = getDevice(db, id);
        if (!before) return fail(res, 404, ...DEVICE_ERROR.missing);
        if (before.status !== 'Pending') {
            return fail(res, 409, 'Only pending devices can be authorized.', 'DEVICE_NOT_PENDING');
        }

        let result;
        try {
            result = db.transaction(() => {
                const issued = issueDeviceTokenForDevice(db, id, {
                    label,
                    purpose,
                    expectedSnapshot: deviceSnapshot(before),
                });
                const device = safeDevice(db, id);
                const purposes = { priorPurpose: before.device_purpose, newPurpose: purpose };
                auditDevice(writeAudit, db, req, session, device, 'trusted_device_authorized', `Authorized device ${label}`, purposes);
                auditDevice(writeAudit, db, req, session, device, 'trusted_device_purpose_assigned', `Assigned ${purpose} purpose to ${label}`, purposes);
                auditDevice(writeAudit, db, req, session, device, 'trusted_device_token_issued', `Issued device token for ${label}`, purposes);
                return { issued, device };
            })();
        } catch (error) {
            return failDeviceMutation(res, fail, error);
        }
        broadcastUpdate();
        oneTimeTokenResponse(res, result.device, result.issued);
    }));

    server.post(['/api/devices/issue-token', '/api/devices/rotate-token'], wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const id = readDeviceId(req, res, fail);
        if (!id) return;
        const before = getDevice(db, id);
        if (!before) return fail(res, 404, ...DEVICE_ERROR.missing);
        if (Object.prototype.hasOwnProperty.call(req.body || {}, 'purpose')) {
            return fail(
                res,
                400,
                'Use the repurpose endpoint to change device purpose.',
                'USE_REPURPOSE_ENDPOINT',
            );
        }
        if (before.status !== 'Authorized') {
            return fail(res, 409, 'Authorize this device before issuing a token.', 'DEVICE_NOT_AUTHORIZED');
        }
        const purpose = normalizeDevicePurpose(before.device_purpose);
        if (!purpose) {
            return fail(res, 400, ...DEVICE_ERROR.purpose);
        }
        const hadToken = Boolean(before.device_token_hash);
        let result;
        try {
            result = db.transaction(() => {
                const issued = issueDeviceTokenForDevice(db, id, {
                    expectedSnapshot: deviceSnapshot(before),
                });
                const device = safeDevice(db, id);
                const purposes = { priorPurpose: purpose, newPurpose: purpose };
                auditDevice(
                    writeAudit,
                    db,
                    req,
                    session,
                    device,
                    hadToken ? 'trusted_device_token_rotated' : 'trusted_device_token_issued',
                    `${hadToken ? 'Rotated' : 'Issued'} device token for ${device.label || id}`,
                    purposes,
                );
                return { issued, device };
            })();
        } catch (error) {
            return failDeviceMutation(res, fail, error);
        }
        broadcastUpdate();
        oneTimeTokenResponse(res, result.device, result.issued);
    }));

    server.post('/api/devices/repurpose', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const id = readDeviceId(req, res, fail);
        if (!id) return;
        const purpose = readPurpose(req, res, fail);
        if (!purpose) return;
        const before = getDevice(db, id);
        if (!before) return fail(res, 404, ...DEVICE_ERROR.missing);
        if (before.status !== 'Authorized') {
            return fail(res, 409, 'Authorize this device before changing its purpose.', 'DEVICE_NOT_AUTHORIZED');
        }
        if (normalizeDevicePurpose(before.device_purpose) === purpose) {
            return fail(res, 409, 'Device already has that purpose.', 'DEVICE_PURPOSE_UNCHANGED');
        }
        let result;
        try {
            result = db.transaction(() => {
                const issued = issueDeviceTokenForDevice(db, id, {
                    purpose,
                    expectedSnapshot: deviceSnapshot(before),
                });
                const device = safeDevice(db, id);
                const purposes = { priorPurpose: before.device_purpose, newPurpose: purpose };
                auditDevice(
                    writeAudit,
                    db,
                    req,
                    session,
                    device,
                    before.device_purpose ? 'trusted_device_purpose_changed' : 'trusted_device_purpose_assigned',
                    `Changed device purpose to ${purpose} for ${device.label || id}`,
                    purposes,
                );
                auditDevice(
                    writeAudit,
                    db,
                    req,
                    session,
                    device,
                    before.device_token_hash ? 'trusted_device_token_rotated' : 'trusted_device_token_issued',
                    `${before.device_token_hash ? 'Rotated' : 'Issued'} device token for ${device.label || id}`,
                    purposes,
                );
                return { issued, device };
            })();
        } catch (error) {
            return failDeviceMutation(res, fail, error);
        }
        broadcastUpdate();
        oneTimeTokenResponse(res, result.device, result.issued);
    }));

    server.post('/api/devices/revoke-token', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const id = readDeviceId(req, res, fail);
        if (!id) return;
        const before = getDevice(db, id);
        if (!before) return fail(res, 404, ...DEVICE_ERROR.missing);
        let result;
        try {
            result = db.transaction(() => {
                const revoked = revokeDeviceToken(db, id, {
                    expectedSnapshot: deviceSnapshot(before),
                });
                const updated = safeDevice(db, id);
                if (revoked.alreadyRevoked) {
                    return { device: updated, alreadyRevoked: true };
                }
                auditDevice(
                    writeAudit,
                    db,
                    req,
                    session,
                    updated,
                    'trusted_device_token_revoked',
                    `Revoked device token for ${updated.label || id}`,
                    { priorPurpose: before.device_purpose, newPurpose: before.device_purpose },
                );
                return { device: updated, alreadyRevoked: false };
            })();
        } catch (error) {
            return failDeviceMutation(res, fail, error);
        }
        if (!result.alreadyRevoked) broadcastUpdate();
        res.json({
            success: true,
            already_revoked: result.alreadyRevoked,
            device: result.device,
        });
    }));

    server.post('/api/devices/delete', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const id = readDeviceId(req, res, fail);
        if (!id) return;
        const before = getDevice(db, id);
        if (!before) return fail(res, 404, ...DEVICE_ERROR.missing);
        const device = sanitizeTrustedDevice(before);
        try {
            db.transaction(() => {
                const deleted = db.run(
                    `DELETE FROM trusted_devices
                      WHERE id=? AND status IS ? AND device_purpose IS ? AND device_token_hash IS ?`,
                    id,
                    before.status ?? null,
                    before.device_purpose ?? '',
                    before.device_token_hash ?? null,
                );
                if (deleted.changes !== 1) {
                    const error = new Error('Device changed.');
                    error.code = 'DEVICE_CHANGED_RETRY';
                    throw error;
                }
                auditDevice(
                    writeAudit,
                    db,
                    req,
                    session,
                    device,
                    'trusted_device_deleted',
                    `Deleted device ${device.label || id}`,
                    { priorPurpose: before.device_purpose, newPurpose: '' },
                );
            })();
        } catch (error) {
            return failDeviceMutation(res, fail, error, {
                status: 500,
                message: 'Device operation failed.',
                code: 'DEVICE_OPERATION_FAILED',
            });
        }
        broadcastUpdate();
        res.json({ success: true });
    }));
}

module.exports = { registerDeviceRoutes };
