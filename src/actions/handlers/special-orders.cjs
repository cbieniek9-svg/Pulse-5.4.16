'use strict';

const {
    assertBetacsEnabled,
    isBetacsEnabled,
    isBetacsRow,
    validateBetacsInsert,
    validateBetacsStatusChange,
    resolveCustomerOrderCloseStatus,
    canForceBetacsComplete,
    LEGACY_CLOSED,
} = require('../../lib/special-orders.cjs');
const { linkOrderToCustomer } = require('../../lib/cs-customers.cjs');

/**
 * special-orders action handlers for POST /api/action.
 * @param {object} deps
 */
function createSpecialOrdersHandlers({ db, broadcastUpdate, getStoreDateStamp, actionHandlers }) {
    return {
        special_orders_insert(ctx) {
            if (ctx.workingData.source === 'betacs') {
                assertBetacsEnabled(db.getSettings());
                validateBetacsInsert(ctx.workingData);
                ctx.workingData.status = 'New';
                ctx.workingData.source = 'betacs';
                ctx.workingData.closed_by = ctx.workingData.closed_by || '';
                const customerId = linkOrderToCustomer(
                    db,
                    db.getSettings(),
                    ctx.workingData,
                    ctx.serverTime,
                );
                if (customerId) ctx.workingData.customer_id = customerId;
            }
            actionHandlers.generic_insert(ctx);
        },

        special_orders_update(ctx) {
            const row = db.get('SELECT * FROM special_orders WHERE order_id = ?', ctx.id_val);
            if (!row) {
                const err = new Error('Order not found.');
                err.status = 404;
                throw err;
            }
            if (isBetacsRow(row)) {
                const settings = db.getSettings();
                const dataKeys = Object.keys(ctx.workingData).filter(
                    (k) => !['closed_by', 'time_closed', 'ordered_at', 'ready_at', 'notes_updated_at', 'notes_updated_by'].includes(k),
                );
                const onlyNotes = dataKeys.length === 1 && dataKeys[0] === 'notes';
                const onlyStatus = dataKeys.length === 1 && dataKeys[0] === 'status';
                const statusAndNotes = dataKeys.length === 2
                    && dataKeys.includes('status')
                    && dataKeys.includes('notes');

                if (onlyNotes) {
                    ctx.workingData.notes = String(ctx.workingData.notes || '').trim().slice(0, 4000);
                    ctx.workingData.notes_updated_at = ctx.serverTime;
                    ctx.workingData.notes_updated_by = ctx.actorName || '';
                    actionHandlers.generic_update(ctx);
                    return;
                }

                if (!onlyStatus && !statusAndNotes) {
                    const err = new Error('Only status and/or notes changes are permitted on CS orders.');
                    err.status = 400;
                    throw err;
                }

                if (ctx.workingData.notes != null) {
                    ctx.workingData.notes = String(ctx.workingData.notes || '').trim().slice(0, 4000);
                    ctx.workingData.notes_updated_at = ctx.serverTime;
                    ctx.workingData.notes_updated_by = ctx.actorName || '';
                }

                let toStatus = resolveCustomerOrderCloseStatus(row, ctx.workingData.status);
                ctx.workingData.status = toStatus;

                if (isBetacsEnabled(settings)) {
                    if (toStatus === 'Complete' && canForceBetacsComplete(row.status)) {
                        // Floor DONE — clear without stepping New→Ordered→Ready→Complete in CS only
                    } else {
                        validateBetacsStatusChange(row.status, toStatus);
                    }
                } else if (toStatus === 'Complete') {
                    ctx.workingData.status = LEGACY_CLOSED;
                    toStatus = LEGACY_CLOSED;
                } else {
                    assertBetacsEnabled(settings);
                }

                if (toStatus === 'Ordered') ctx.workingData.ordered_at = ctx.serverTime;
                if (toStatus === 'Ready') ctx.workingData.ready_at = ctx.serverTime;
            } else if (ctx.workingData.status === 'Complete') {
                ctx.workingData.status = LEGACY_CLOSED;
            } else if (ctx.workingData.notes != null) {
                ctx.workingData.notes = String(ctx.workingData.notes || '').trim().slice(0, 4000);
                ctx.workingData.notes_updated_at = ctx.serverTime;
                ctx.workingData.notes_updated_by = ctx.actorName || '';
            }
            actionHandlers.generic_update(ctx);
        },
    };
}

module.exports = { createSpecialOrdersHandlers };
