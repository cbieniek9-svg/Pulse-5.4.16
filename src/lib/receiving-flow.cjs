'use strict';

function wantsWorkOrderTask(workingData) {
    const v = workingData?.post_work_task ?? workingData?.create_task;
    if (v === false || v === 0 || v === '0' || v === 'no' || v === 'false') return false;
    return true;
}

/** @deprecated alias — checkbox controls work-order task only, not dock receive tasks */
function wantsReceivingTask(workingData) {
    return wantsWorkOrderTask(workingData);
}

function receivingTaskFlag(workingData) {
    return wantsWorkOrderTask(workingData) ? 1 : 0;
}

function isTgpVendor(vendor) {
    return /^TGP\b/i.test(String(vendor || '').trim());
}

const ALL_STAFF_ASSIGNEE = 'All Staff';

function workTaskAssigneeForOrder(order) {
    return isTgpVendor(order?.vendor) ? ALL_STAFF_ASSIGNEE : 'Unassigned';
}

/** @deprecated use workTaskAssigneeForOrder */
function workTaskAssignee() {
    return ALL_STAFF_ASSIGNEE;
}

/**
 * Work-order task at time out — optional via post_work_task / create_task in request body.
 * TGP and non-TGP vendors; order clock is separate (see wantsOrderClockStart).
 */
function orderRequestedWorkTask(order, workingData) {
    if (!order) return false;
    return wantsWorkOrderTask(workingData || { create_task: order.create_task });
}

/**
 * Explicit order-clock start at TGP time out.
 * Requires start_order_clock / startOrderClock — create_task alone does not start the clock.
 */
function wantsOrderClockStart(workingData) {
    const explicit = workingData?.start_order_clock ?? workingData?.startOrderClock;
    if (explicit === true || explicit === 1 || explicit === '1' || explicit === 'yes' || explicit === 'true') {
        return true;
    }
    return false;
}

function vendorWorkTaskId(order) {
    const expId = String(order?.exp_id || '').trim();
    if (isTgpVendor(order?.vendor)) return `T-TGP-${expId}`;
    return `T-WORK-${expId}`;
}

function vendorWorkTaskDetail(order) {
    const vendor = String(order?.vendor || 'vendor').trim() || 'vendor';
    if (isTgpVendor(vendor)) return 'Work the TGP order';
    return `Work ${vendor} order`;
}


function normalizeInvoiceRef(value) {
    const raw = String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
    if (!raw) return '';
    return raw.slice(0, 120);
}

function hasInvoiceRefInput(workingData) {
    return Object.prototype.hasOwnProperty.call(workingData || {}, 'invoice_ref')
        || Object.prototype.hasOwnProperty.call(workingData || {}, 'invoiceRef')
        || Object.prototype.hasOwnProperty.call(workingData || {}, 'invoice')
        || Object.prototype.hasOwnProperty.call(workingData || {}, 'reference');
}

function readInvoiceRef(workingData) {
    if (!workingData) return '';
    return normalizeInvoiceRef(
        workingData.invoice_ref ?? workingData.invoiceRef ?? workingData.invoice ?? workingData.reference ?? '',
    );
}

/**
 * @param {object} db
 * @param {object} order — expected_orders row
 * @param {string} arrivalTime
 * @param {string} completionTime
 * @param {string} processedBy
 */
function writeReceivingStat(db, order, arrivalTime, completionTime, processedBy) {
    if (!order?.exp_id || !arrivalTime || !completionTime) return;
    const startMs = Date.parse(arrivalTime);
    const endMs = Date.parse(completionTime);
    if (!(startMs > 0) || !(endMs > 0) || endMs < startMs) return;
    const duration = (endMs - startMs) / 60000;
    db.run(
        `INSERT OR REPLACE INTO receiving_stats (id, vendor, arrival_time, completion_time, duration_mins, processed_by)
         VALUES (?,?,?,?,?,?)`,
        `STAT-${order.exp_id}`,
        order.vendor,
        arrivalTime,
        completionTime,
        duration,
        processedBy,
    );
}

module.exports = {
    wantsWorkOrderTask,
    wantsReceivingTask,
    wantsOrderClockStart,
    receivingTaskFlag,
    isTgpVendor,
    orderRequestedWorkTask,
    workTaskAssignee,
    workTaskAssigneeForOrder,
    ALL_STAFF_ASSIGNEE,
    vendorWorkTaskId,
    vendorWorkTaskDetail,
    normalizeInvoiceRef,
    hasInvoiceRefInput,
    readInvoiceRef,
    writeReceivingStat,
};
