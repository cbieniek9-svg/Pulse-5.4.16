'use strict';

const crypto = require('crypto');
const { ACTION_SCHEMAS } = require('../constants/action-schema.cjs');
const { validateAction } = require('../validation/action-request.cjs');
const { logOrderAudit, orderSnapshot } = require('../lib/special-orders.cjs');
const { logManagerAudit } = require('../lib/audit-log.cjs');
const { isManagerRole } = require('../lib/staff-permissions.cjs');
const { DEVICE_PURPOSES, canDevicePerform } = require('../lib/device-access-policy.cjs');
const {
    findAuthorizedTrustedDevice,
    assertCurrentDeviceAuthorization,
} = require('../lib/trusted-device-tokens.cjs');

const TERMINAL_ORDER_STATUSES = new Set(['Closed', 'Archived', 'Complete']);
const MANAGER_AUDITED_TABLES = new Set(['settings', 'staff', 'rhythm_tasks', 'vendor_schedule']);
const DEVICE_ACTORS = Object.freeze({
    tv: 'TV_DISPLAY',
    cs_desk: 'CS_DESK',
    receiving: 'RECEIVING_STATION',
    markdown: 'MARKDOWN_STATION',
});
const ACTION_SECRET_FIELDS = new Set(['pin', 'pin_hashed', 'token', 'deviceToken', 'device_token']);

// Keep actor labels for every known device purpose; fail closed if a purpose is added without a label.
for (const purpose of DEVICE_PURPOSES) {
    if (!DEVICE_ACTORS[purpose]) {
        throw new Error(`DEVICE_ACTORS missing mapping for purpose: ${purpose}`);
    }
}

function nonEmptyCredential(value) {
    const candidate = Array.isArray(value) ? value[0] : value;
    return typeof candidate === 'string' && candidate.length > 0 ? candidate : '';
}

function assertConsistentCredentials(values) {
    const credentials = values.map(nonEmptyCredential).filter(Boolean);
    if (new Set(credentials).size > 1) {
        const error = new Error('Conflicting credentials were provided.');
        error.status = 400;
        error.code = 'CONFLICTING_CREDENTIALS';
        throw error;
    }
}

function resolveActionSessionToken(req) {
    const headerToken = nonEmptyCredential(req.headers?.['x-session-token']);
    const bodyToken = nonEmptyCredential(req.body?.token);
    const contextToken = nonEmptyCredential(req.body?.userContext?.token);
    assertConsistentCredentials([headerToken, bodyToken, contextToken]);
    assertConsistentCredentials([
        req.headers?.['x-device-token'],
        req.body?.deviceToken,
        req.body?.device_token,
    ]);
    return headerToken || bodyToken || contextToken || '';
}

function actionAuditDetail(table, idVal, workingData) {
    const keys = Object.keys(workingData || {});
    return JSON.stringify({
        target: idVal ?? workingData?.name ?? workingData?.setting_name ?? null,
        table,
        fields_changed: keys.filter((key) => !ACTION_SECRET_FIELDS.has(key)),
        redacted_fields: keys.filter((key) => ACTION_SECRET_FIELDS.has(key)),
    });
}

function safeActionError(error) {
    if (String(error?.code || '').startsWith('SQLITE_CONSTRAINT')) {
        return {
            status: 409,
            message: 'Action conflicts with an existing record.',
            code: 'ACTION_CONFLICT',
        };
    }
    if (Number.isInteger(error?.status) && error.status >= 400 && error.status < 500) {
        return {
            status: error.status,
            message: error.message || 'Action rejected.',
            code: error.code || 'ACTION_REJECTED',
        };
    }
    return { status: 500, message: 'Action failed.', code: 'ACTION_FAILED' };
}

function requiredDevicePurpose(table, action) {
    for (const purpose of DEVICE_PURPOSES) {
        if (canDevicePerform(purpose, table, action)) return purpose;
    }
    return '';
}

function managerAuditSummary(table, action, idVal) {
    if (table === 'settings') return `Changed setting ${idVal}`;
    if (table === 'staff') return `${action} staff record ${idVal}`;
    if (table === 'rhythm_tasks') return `${action} rhythm task ${idVal}`;
    if (table === 'vendor_schedule') return `${action} vendor schedule ${idVal}`;
    if (table === 'tasks' && action === 'delete') return `Deleted task ${idVal}`;
    return `${action} ${table} ${idVal ?? ''}`.trim();
}

/**
 * @param {import('express').Application} server
 * @param {object} ctx
 */
function registerActionRoutes(server, ctx) {
    const {
        wrap, fail, db, auth, actionHandlers, checkSettingPermission,
    } = ctx;

    server.post('/api/action', wrap(async (req, res) => {
        const { table, action, data, id_col, id_val, userContext } = req.body ?? {};

        validateAction({ table, action, data, id_col, id_val });

        const effectiveToken = resolveActionSessionToken(req);
        const session = auth.getSession(effectiveToken);

        let actorName = await auth.resolveActionActor({
            token: effectiveToken,
            userContext: userContext || (session ? { name: session.name, token: effectiveToken } : null),
            table,
            action,
            data,
        });
        let deviceAuthorization = null;
        let devicePurpose = '';
        if (!actorName) {
            // A token that no longer resolves means the session died (restart, timeout,
            // deactivation) — 401 so the client re-prompts instead of showing a raw error.
            if (effectiveToken) return fail(res, 401, 'Session expired. Please sign in again.');
            devicePurpose = requiredDevicePurpose(table, action);
            if (devicePurpose) {
                deviceAuthorization = findAuthorizedTrustedDevice(db, req, { requiredPurpose: devicePurpose });
                if (!deviceAuthorization.authorized) {
                    if (deviceAuthorization.code === 'DEVICE_CAPABILITY_FORBIDDEN') {
                        return fail(res, 403, 'Device purpose is not permitted for this action.', deviceAuthorization.code);
                    }
                    if (deviceAuthorization.code === 'INVALID_DEVICE_TOKEN') {
                        return fail(res, 401, 'Device token is invalid or revoked.', deviceAuthorization.code);
                    }
                    return fail(res, 401, 'Pair this station device before submitting actions.', 'STATION_DEVICE_AUTH_REQUIRED');
                }
                actorName = DEVICE_ACTORS[devicePurpose];
                if (!actorName) {
                    return fail(res, 403, 'Device purpose is not permitted for this action.', 'DEVICE_ACTOR_UNMAPPED');
                }
            } else {
                return fail(res, 403, 'Authentication required.');
            }
        }

        const requireLiveSession = (message) => {
            if (session) return false;
            fail(res, effectiveToken ? 401 : 403, effectiveToken ? 'Session expired. Please sign in again.' : message);
            return true;
        };

        if (table === 'staff') {
            const { isManagerRole } = require('../lib/staff-permissions.cjs');
            if (requireLiveSession('Manager role required for staff changes.')) return;
            if (!isManagerRole(session.role)) {
                return fail(res, 403, 'Manager role required for staff changes.');
            }
        }
        if (['rhythm_tasks', 'vendor_schedule'].includes(table)) {
            const { isManagerRole } = require('../lib/staff-permissions.cjs');
            if (requireLiveSession('Manager role required for schedule template changes.')) return;
            if (!isManagerRole(session.role)) {
                return fail(res, 403, 'Manager role required for schedule template changes.');
            }
        }
        if (table === 'tasks') {
            const { hasStaffPermission, isManagerRole, isShiftLeadRole } = require('../lib/staff-permissions.cjs');
            if (requireLiveSession('Valid session required for task changes.')) return;
            if (action === 'delete' && !isManagerRole(session.role)) {
                return fail(res, 403, 'Manager role required to delete tasks.');
            }
            if (action === 'insert' && !isManagerRole(session.role) && !isShiftLeadRole(session.role)) {
                return fail(res, 403, 'Manager or shift lead required to create tasks.');
            }
            if (action === 'update') {
                const assigning = Object.prototype.hasOwnProperty.call(data || {}, 'assigned_to');
                const closing = data?.status === 'Closed' || data?.status === 'Archived';
                const isLead = isManagerRole(session.role) || isShiftLeadRole(session.role);
                if (assigning && !isLead) {
                    return fail(res, 403, 'Manager or shift lead required to reassign tasks.');
                }
                if (!isLead && closing && !hasStaffPermission(db, session, 'tasks')) {
                    return fail(res, 403, 'Task completion permission required.');
                }
            }
        }

        const serverTime = new Date().toISOString();
        const originalData = data && typeof data === 'object' ? data : {};
        const workingData = data ? { ...data } : {};
        const clientIp = req.ip || req.socket?.remoteAddress || '';

        let priorOrder = null;
        if (table === 'special_orders' && id_val != null) {
            priorOrder = db.get('SELECT * FROM special_orders WHERE order_id = ?', id_val);
        }

        if (table === 'settings' && id_val) {
            const ok = await checkSettingPermission(res, String(id_val), effectiveToken, userContext);
            if (!ok) return;
        }

        if (action === 'insert') {
            const cols = ACTION_SCHEMAS[table].columns;
            if (cols.includes('logged_by')) workingData.logged_by = actorName;
            if (cols.includes('time_submitted')) workingData.time_submitted = serverTime;
            if (cols.includes('time_logged')) workingData.time_logged = serverTime;
        }
        if (workingData.status === 'Closed' || workingData.status === 'Archived' || workingData.status === 'Complete') {
            const cols = ACTION_SCHEMAS[table].columns;
            if (cols.includes('closed_by')) {
                if (table === 'tasks' && action === 'update' && id_val != null) {
                    const row = db.get('SELECT assigned_to FROM tasks WHERE task_id = ?', id_val);
                    const assignee = row && row.assigned_to;
                    workingData.closed_by = (assignee && assignee !== 'Unassigned') ? assignee : actorName;
                } else {
                    workingData.closed_by = actorName;
                }
            }
            if (cols.includes('time_closed')) {
                const hasExplicitTimeClosed = Object.prototype.hasOwnProperty.call(originalData, 'time_closed')
                    && originalData.time_closed != null
                    && String(originalData.time_closed).trim() !== '';
                if (!hasExplicitTimeClosed) workingData.time_closed = serverTime;
            }
        }

        const handler = actionHandlers[`${table}_${action}`] || actionHandlers[`generic_${action}`];
        if (!handler) return fail(res, 400, `No handler for ${table}/${action}.`);

        const canDeferBroadcasts = (
            typeof actionHandlers.beginDeferredBroadcasts === 'function'
            && typeof actionHandlers.flushDeferredBroadcasts === 'function'
            && typeof actionHandlers.discardDeferredBroadcasts === 'function'
        );
        try {
            if (canDeferBroadcasts) actionHandlers.beginDeferredBroadcasts();
            db.transaction(() => {
                if (deviceAuthorization) {
                    assertCurrentDeviceAuthorization(db, deviceAuthorization, req, devicePurpose);
                }

                const handlerResult = handler({
                    table, workingData, id_col, id_val, actorName, serverTime,
                });
                if (handlerResult && typeof handlerResult.then === 'function') {
                    Promise.resolve(handlerResult).catch(() => {});
                    throw new Error('Action handlers must be synchronous.');
                }

                if (table === 'staff' && (action === 'update' || action === 'delete')) {
                    // Role, active and app_access are re-read per request, but revoking outright
                    // means a removed or locked-out account cannot make even one more call.
                    const staffId = Number(id_col === 'id' ? id_val : NaN);
                    auth.destroySessionsForStaff({
                        staffId: Number.isFinite(staffId) ? staffId : null,
                        name: id_col === 'name' ? String(id_val) : (workingData.name ?? null),
                    });
                }

                if (table === 'special_orders') {
                    const afterRow = db.get('SELECT * FROM special_orders WHERE order_id = ?', id_val ?? workingData.order_id);
                    if (action === 'insert') {
                        logOrderAudit(db, {
                            orderId: workingData.order_id,
                            actor: actorName,
                            action: 'insert',
                            fromStatus: '',
                            toStatus: afterRow?.status || workingData.status,
                            snapshot: orderSnapshot(afterRow || workingData),
                            ip: clientIp,
                        });
                    } else if (action === 'update' && priorOrder) {
                        logOrderAudit(db, {
                            orderId: String(id_val),
                            actor: actorName,
                            action: TERMINAL_ORDER_STATUSES.has(workingData.status) ? 'complete' : 'status_change',
                            fromStatus: priorOrder.status,
                            toStatus: workingData.status,
                            snapshot: orderSnapshot({ ...priorOrder, ...workingData }),
                            ip: clientIp,
                        });
                    }
                }

                db.upsertAudit(
                    crypto.randomUUID(),
                    serverTime,
                    actorName,
                    action,
                    table,
                    actionAuditDetail(table, id_val, workingData),
                );

                const shouldManagerAudit = MANAGER_AUDITED_TABLES.has(table)
                    || (table === 'tasks' && action === 'delete' && session && isManagerRole(session.role));
                if (shouldManagerAudit) {
                    logManagerAudit(db, {
                        req,
                        session,
                        actorName,
                        action: `${table}_${action}`,
                        targetType: table,
                        targetId: id_val ?? workingData?.[id_col] ?? workingData?.setting_name ?? null,
                        summary: managerAuditSummary(table, action, id_val ?? workingData?.[id_col] ?? workingData?.setting_name),
                        metadata: {
                            fields_changed: Object.keys(workingData || {}).filter((k) => !['pin', 'token'].includes(String(k).toLowerCase())),
                            redacted_fields: Object.keys(workingData || {}).filter((k) => ['pin', 'token'].includes(String(k).toLowerCase())),
                        },
                    });
                }
            })();
        } catch (handlerErr) {
            if (canDeferBroadcasts) actionHandlers.discardDeferredBroadcasts();
            console.error(`[ACTION] ${table}/${action} by ${actorName}:`, handlerErr.message);
            const safeError = safeActionError(handlerErr);
            return fail(res, safeError.status, safeError.message, safeError.code);
        }

        // Broadcast after commit so a flush failure cannot undo a successful write response.
        try {
            if (canDeferBroadcasts) actionHandlers.flushDeferredBroadcasts();
        } catch (broadcastErr) {
            console.error(`[ACTION] broadcast flush after ${table}/${action}:`, broadcastErr?.message || broadcastErr);
        }

        res.json({ success: true });
    }));
}

module.exports = { registerActionRoutes };
