'use strict';

const { writeReceivingStat, normalizeInvoiceRef } = require('./receiving-flow.cjs');

function parseOptionalIso(fieldName, value, fallback) {
    if (value === null || value === undefined || value === '') {
        return fallback || '';
    }
    if (typeof value !== 'string') {
        const err = new Error(`${fieldName} must be a date/time string.`);
        err.status = 400;
        throw err;
    }
    const t = Date.parse(value);
    if (Number.isNaN(t)) {
        const err = new Error(`Invalid ${fieldName}.`);
        err.status = 400;
        throw err;
    }
    return new Date(t).toISOString();
}

/**
 * Manager correction for archived receiving log rows (times + invoice ref).
 * Rebuilds receiving_stats duration when both times are present.
 */
function applyReceivingLogCorrection(db, {
    expId,
    arrivedAt,
    departedAt,
    invoiceRef,
    actorName,
}) {
    const id = String(expId || '').trim();
    if (!id) {
        const err = new Error('exp_id is required.');
        err.status = 400;
        throw err;
    }

    const order = db.get('SELECT * FROM expected_orders WHERE exp_id = ?', id);
    if (!order) {
        const err = new Error('Receiving log not found.');
        err.status = 404;
        throw err;
    }

    const arrived_at = parseOptionalIso('arrived_at', arrivedAt, order.arrived_at);
    let departed_at = order.departed_at || '';
    if (departedAt !== undefined) {
        departed_at = departedAt === null || departedAt === ''
            ? ''
            : parseOptionalIso('departed_at', departedAt, order.departed_at);
    }

    const invoice_ref = invoiceRef !== undefined
        ? normalizeInvoiceRef(invoiceRef)
        : normalizeInvoiceRef(order.invoice_ref);

    if (departed_at && !arrived_at) {
        const err = new Error('Time in is required when time out is set.');
        err.status = 400;
        throw err;
    }
    if (arrived_at && departed_at && Date.parse(departed_at) < Date.parse(arrived_at)) {
        const err = new Error('Time out must be on or after time in.');
        err.status = 400;
        throw err;
    }

    const arrived = arrived_at ? 1 : 0;
    let status = order.status || 'Pending';
    if (departed_at) {
        status = 'Closed';
    } else if (arrived_at) {
        status = status === 'Closed' ? 'Arrived' : (status === 'Pending' ? 'Arrived' : status);
    }

    const time_closed = departed_at || (status === 'Closed' ? order.time_closed : '');
    const closed_by = departed_at
        ? (order.departed_by || order.closed_by || actorName)
        : order.closed_by;

    db.run(
        `UPDATE expected_orders
         SET arrived=?, arrived_at=?, departed_at=?, invoice_ref=?, status=?, time_closed=?, closed_by=?
         WHERE exp_id=?`,
        arrived,
        arrived_at || null,
        departed_at || null,
        invoice_ref,
        status,
        time_closed || null,
        closed_by || null,
        id,
    );

    const statId = `STAT-${id}`;
    if (arrived_at && departed_at) {
        const processedBy = order.departed_by || order.arrived_by || actorName || '';
        writeReceivingStat(
            db,
            { ...order, exp_id: id, vendor: order.vendor },
            arrived_at,
            departed_at,
            processedBy,
        );
    } else {
        try {
            db.run('DELETE FROM receiving_stats WHERE id = ?', statId);
        } catch (_) { /* optional */ }
    }

    const duration_mins = (arrived_at && departed_at)
        ? Math.round(((Date.parse(departed_at) - Date.parse(arrived_at)) / 60000) * 10) / 10
        : null;

    return {
        exp_id: id,
        vendor: order.vendor,
        arrived_at: arrived_at || '',
        departed_at: departed_at || '',
        invoice_ref,
        status,
        duration_mins,
    };
}

module.exports = {
    applyReceivingLogCorrection,
    parseOptionalIso,
};
