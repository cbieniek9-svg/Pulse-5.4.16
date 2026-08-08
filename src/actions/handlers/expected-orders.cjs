'use strict';

const {
    receivingTaskFlag,
    writeReceivingStat,
    isTgpVendor,
    orderRequestedWorkTask,
    wantsOrderClockStart,
    vendorWorkTaskId,
    vendorWorkTaskDetail,
    hasInvoiceRefInput,
    readInvoiceRef,
    workTaskAssigneeForOrder,
} = require('../../lib/receiving-flow.cjs');
const {
    assertTgpPalletIntakeComplete,
    storageConfirmed,
} = require('../../lib/receiving-pallets.cjs');
const { logInfo, logWarn } = require('../../lib/app-log.cjs');
const { normalizeVendorInput } = require('../../lib/vendor-canonical.cjs');
const { upsertSetting } = require('../../lib/settings-store.cjs');
const { normalizeExpectedDay } = require('../../lib/expected-orders-day.cjs');

/**
 * expected-orders action handlers for POST /api/action.
 * @param {object} deps
 */
function createExpectedOrdersHandlers({ db, broadcastUpdate, getStoreDateStamp, actionHandlers }) {
    return {
        expected_orders_insert(ctx) {
            ctx.workingData.expected_day = normalizeExpectedDay(ctx.workingData.expected_day, getStoreDateStamp);
            actionHandlers.generic_insert(ctx);
        },

        expected_orders_update(ctx) {
            if (ctx.workingData?.status === 'Archived') {
                const row = db.get('SELECT * FROM expected_orders WHERE exp_id = ?', ctx.id_val);
                if (!row) {
                    const err = new Error('Delivery not found.');
                    err.status = 404;
                    throw err;
                }
                const arrived = Number(row.arrived) === 1 || !!row.arrived_at || row.status === 'Arrived' || row.status === 'Closed';
                if (row.status !== 'Pending' || arrived) {
                    const err = new Error('Only pending deliveries (not yet TIME IN) can be removed.');
                    err.status = 409;
                    throw err;
                }
            }
            actionHandlers.generic_update(ctx);
        },

        expected_orders_receiving_mark_arrived(ctx) {
            const order = db.get('SELECT * FROM expected_orders WHERE exp_id = ?', ctx.id_val);
            if (!order) {
                const err = new Error('Delivery not found.');
                err.status = 404;
                throw err;
            }
            if (order.arrived) {
                const err = new Error('Vendor already checked in.');
                err.status = 409;
                throw err;
            }
            const canonicalVendor = normalizeVendorInput(db, order.vendor);
            db.run(
                "UPDATE expected_orders SET vendor=?, status='Arrived', arrived=1, arrived_at=?, arrived_by=? WHERE exp_id=?",
                canonicalVendor, ctx.serverTime, ctx.actorName, ctx.id_val,
            );
            broadcastUpdate({
                table: 'expected_orders',
                action: 'update',
                id_col: 'exp_id',
                id_val: ctx.id_val,
                data: {
                    vendor: canonicalVendor,
                    status: 'Arrived',
                    arrived: 1,
                    arrived_at: ctx.serverTime,
                    arrived_by: ctx.actorName,
                },
            });
        },

        expected_orders_receiving_mark_departed(ctx) {
            const order = db.get('SELECT * FROM expected_orders WHERE exp_id = ?', ctx.id_val);
            if (!order) {
                const err = new Error('Delivery not found.');
                err.status = 404;
                throw err;
            }
            if (!order.arrived || !order.arrived_at) {
                const err = new Error('Check in (time in) before time out.');
                err.status = 400;
                throw err;
            }
            if (order.departed_at) {
                const err = new Error('Vendor already checked out.');
                err.status = 409;
                throw err;
            }
            const canonicalVendor = normalizeVendorInput(db, order.vendor);
            const taskId = `T-REC-${ctx.id_val}`;
            const hasInvoiceInput = hasInvoiceRefInput(ctx.workingData);
            const invoiceRef = hasInvoiceInput ? readInvoiceRef(ctx.workingData) : '';
            if (isTgpVendor(canonicalVendor)) {
                assertTgpPalletIntakeComplete(db, { ...order, vendor: canonicalVendor });
                if (!storageConfirmed(ctx.workingData)) {
                    const err = new Error('Confirm truck receiving and proper storage before time out.');
                    err.status = 400;
                    throw err;
                }
            }
            let orderClockStarted = false;
            let workTask = null;
            let workTaskInserted = false;
            let workTaskReopened = false;
            let receiveTaskClosed = false;
            db.transaction(() => {
                const updateCols = [
                    'vendor=?',
                    "status='Closed'",
                    'departed_at=?',
                    'departed_by=?',
                    'time_closed=?',
                    'closed_by=?',
                ];
                const updateParams = [canonicalVendor, ctx.serverTime, ctx.actorName, ctx.serverTime, ctx.actorName];
                if (hasInvoiceInput) {
                    updateCols.push('invoice_ref=?');
                    updateParams.push(invoiceRef);
                }
                updateParams.push(ctx.id_val);
                db.run(
                    `UPDATE expected_orders SET ${updateCols.join(', ')} WHERE exp_id=?`,
                    ...updateParams,
                );
                const task = db.get('SELECT status FROM tasks WHERE task_id = ?', taskId);
                if (task?.status === 'Open') {
                    db.run(
                        "UPDATE tasks SET status='Closed', time_closed=?, closed_by=? WHERE task_id=?",
                        ctx.serverTime, ctx.actorName, taskId,
                    );
                    receiveTaskClosed = true;
                }
                writeReceivingStat(db, { ...order, vendor: canonicalVendor }, order.arrived_at, ctx.serverTime, ctx.actorName);

                const canonicalOrder = { ...order, vendor: canonicalVendor };
                const shouldCreateFollowUp = orderRequestedWorkTask(canonicalOrder, ctx.workingData);
                if (shouldCreateFollowUp && isTgpVendor(canonicalVendor) && wantsOrderClockStart(ctx.workingData)) {
                    const orderStart = db.get("SELECT setting_value FROM settings WHERE setting_name='Order_Start'")?.setting_value;
                    const orderEnd = db.get("SELECT setting_value FROM settings WHERE setting_name='Order_End'")?.setting_value;
                    const storeDate = typeof getStoreDateStamp === 'function' ? getStoreDateStamp() : '';
                    const finishedToday = storeDate
                        ? db.get(
                            "SELECT store_date FROM shift_order_history WHERE store_date = ? AND order_end IS NOT NULL AND order_end != '' LIMIT 1",
                            storeDate,
                        )
                        : null;
                    if (orderEnd) {
                        logWarn('receiving/order-clock', 'Skipped auto-start — stuck clock has Order_End set', {
                            expId: ctx.id_val,
                            vendor: canonicalVendor,
                            actor: ctx.actorName,
                        }, db);
                    } else if (finishedToday) {
                        logWarn('receiving/order-clock', 'Skipped auto-start — order already finished today', {
                            expId: ctx.id_val,
                            vendor: canonicalVendor,
                            storeDate,
                            actor: ctx.actorName,
                        }, db);
                    } else if (!orderStart) {
                        // Must upsert: Order_Start is not seeded, so a bare UPDATE matches
                        // 0 rows on a fresh DB while still broadcasting a fake "started" event.
                        upsertSetting(db, 'Order_Start', ctx.serverTime);
                        orderClockStarted = true;
                        logInfo('receiving/order-clock', 'Order clock started from TGP time out', {
                            expId: ctx.id_val,
                            vendor: canonicalVendor,
                            actor: ctx.actorName,
                            at: ctx.serverTime,
                        }, db);
                    } else {
                        logInfo('receiving/order-clock', 'Clock already running — left Order_Start unchanged', {
                            expId: ctx.id_val,
                            vendor: canonicalVendor,
                            actor: ctx.actorName,
                        }, db);
                    }
                } else if (shouldCreateFollowUp && isTgpVendor(canonicalVendor)) {
                    logInfo('receiving/order-clock', 'Work task requested without starting order clock', {
                        expId: ctx.id_val,
                        vendor: canonicalVendor,
                        actor: ctx.actorName,
                    }, db);
                }

                if (shouldCreateFollowUp) {
                    const workId = vendorWorkTaskId(canonicalOrder);
                    const detail = vendorWorkTaskDetail(canonicalOrder);
                    const assignee = workTaskAssigneeForOrder(canonicalOrder);
                    const existingWork = db.get('SELECT * FROM tasks WHERE task_id = ?', workId);
                    if (existingWork?.status === 'Open') {
                        workTask = existingWork;
                    } else {
                        workTask = {
                            task_id: workId,
                            task_detail: detail,
                            status: 'Open',
                            priority: 'Urgent',
                            zone: 'Receiving',
                            assigned_to: assignee,
                            time_submitted: ctx.serverTime,
                            related_id: ctx.id_val,
                        };
                        if (existingWork) {
                            db.run(
                                `UPDATE tasks
                                 SET task_detail=?, status='Open', priority='Urgent', zone='Receiving',
                                     assigned_to=?, time_submitted=?, time_closed=NULL,
                                     closed_by=NULL, related_id=?
                                 WHERE task_id=?`,
                                detail, assignee, ctx.serverTime, ctx.id_val, workId,
                            );
                            workTaskReopened = true;
                        } else {
                            db.run(
                                `INSERT INTO tasks (task_id, task_detail, status, priority, zone, assigned_to, time_submitted, related_id)
                                 VALUES (?,?,?,?,?,?,?,?)`,
                                workId, detail, 'Open', 'Urgent', 'Receiving', assignee, ctx.serverTime, ctx.id_val,
                            );
                            workTaskInserted = true;
                        }
                    }
                    db.run(
                        'UPDATE expected_orders SET create_task=? WHERE exp_id=?',
                        receivingTaskFlag(ctx.workingData),
                        ctx.id_val,
                    );
                }
            })();
            const orderUpdate = { vendor: canonicalVendor, status: 'Closed', departed_at: ctx.serverTime, departed_by: ctx.actorName };
            if (hasInvoiceInput) orderUpdate.invoice_ref = invoiceRef;
            broadcastUpdate({ table: 'expected_orders', action: 'update', id_col: 'exp_id', id_val: ctx.id_val, data: orderUpdate });
            if (receiveTaskClosed) {
                broadcastUpdate({
                    table: 'tasks', action: 'update', id_col: 'task_id', id_val: taskId,
                    data: { status: 'Closed', time_closed: ctx.serverTime, closed_by: ctx.actorName },
                });
            }
            if (orderClockStarted) {
                broadcastUpdate({ table: 'settings', action: 'update', id_col: 'setting_name', id_val: 'Order_Start', data: { setting_value: ctx.serverTime } });
            }
            if (workTaskInserted && workTask) {
                broadcastUpdate({ table: 'tasks', action: 'insert', data: workTask });
            } else if (workTaskReopened && workTask) {
                broadcastUpdate({ table: 'tasks', action: 'update', id_col: 'task_id', id_val: workTask.task_id, data: workTask });
            }
        },

        expected_orders_receiving_log_arrival(ctx) {
            const vendor = normalizeVendorInput(db, ctx.workingData.vendor);
            if (!vendor) {
                const err = new Error('Vendor name is required.');
                err.status = 400;
                throw err;
            }
            const expId = `E-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
            const expectedDay = normalizeExpectedDay(ctx.workingData.expected_day, getStoreDateStamp);
            db.run(
                `INSERT INTO expected_orders (
                    exp_id, vendor, expected_day, status, logged_by, category,
                    arrived, arrived_at, arrived_by
                ) VALUES (?,?,?,?,?,?,1,?,?)`,
                expId, vendor.slice(0, 120), expectedDay, 'Arrived', ctx.actorName, 'general',
                ctx.serverTime, ctx.actorName,
            );
            broadcastUpdate({
                table: 'expected_orders',
                action: 'insert',
                data: { exp_id: expId, vendor, status: 'Arrived', arrived: 1 },
            });
        },

        expected_orders_hardware_arrive(ctx) {
            const order = db.getHardwareOrder(ctx.id_val);
            if (!order) {
                const err = new Error('Delivery not found.');
                err.status = 404;
                throw err;
            }
            if (order.arrived) {
                const err = new Error('Vendor already checked in.');
                err.status = 409;
                throw err;
            }
            db.transaction(() => {
                db.updateHardwareArrive(ctx.id_val, ctx.actorName, ctx.serverTime);
                db.incrementHardwareCount(order.pieces || 0);
            })();
            broadcastUpdate({ table: 'expected_orders', action: 'update', id_col: 'exp_id', id_val: ctx.id_val, data: { arrived: 1 } });
            broadcastUpdate({ table: 'counts', action: 'update', id_col: 'id', id_val: 1, data: { hardware: db.getCounts()?.hardware ?? 0 } });
        },

        expected_orders_hardware_unarrive(ctx) {
            const order = db.getHardwareOrder(ctx.id_val);
            if (!order) {
                const err = new Error('Delivery not found.');
                err.status = 404;
                throw err;
            }
            if (!order.arrived) {
                const err = new Error('Vendor is not marked arrived.');
                err.status = 409;
                throw err;
            }
            db.transaction(() => {
                db.updateHardwareUnarrive(ctx.id_val);
                db.decrementHardwareCount(order.pieces || 0);
            })();
            broadcastUpdate({ table: 'expected_orders', action: 'update', id_col: 'exp_id', id_val: ctx.id_val, data: { arrived: 0 } });
            broadcastUpdate({ table: 'counts', action: 'update', id_col: 'id', id_val: 1, data: { hardware: db.getCounts()?.hardware ?? 0 } });
        },
    };
}

module.exports = { createExpectedOrdersHandlers };
