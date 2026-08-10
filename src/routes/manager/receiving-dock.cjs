'use strict';

const {
    addReceivingPallet,
    updateReceivingPallet,
    deleteReceivingPallet,
    listReceivingDayLog,
    PALLET_DEPARTMENTS,
    TGP_STORAGE_CONFIRM_PROMPT,
} = require('../../lib/receiving-pallets.cjs');
const { applyReceivingLogCorrection } = require('../../lib/receiving-log-correction.cjs');
const { logManagerAudit } = require('../../lib/audit-log.cjs');
const {
    isStoreTransfersEnabled,
    listTransferCustomers,
    createStoreTransfer,
    searchStoreTransfers,
    getStoreTransfer,
    resolveTransferFilePath,
} = require('../../lib/store-transfers.cjs');
const { isManagerRole } = require('../../lib/staff-permissions.cjs');
const { createReceivingGuards } = require('./receiving-helpers.cjs');

/**
 * Dock / ops receiving routes (pallets, store transfers, log correction).
 */
function registerReceivingDockRoutes(server, ctx) {
    const { wrap, fail, requireSession, db, broadcastUpdate, getStoreDateStamp } = ctx;
    const { requireReceivingAuth } = createReceivingGuards(ctx);

    server.get('/api/receiving/pallet-departments', wrap(async (req, res) => {
        res.json({ success: true, departments: PALLET_DEPARTMENTS });
    }));

    server.get('/api/receiving/store-transfers/config', wrap(async (req, res) => {
        const session = requireReceivingAuth(req, res);
        if (!session) return;
        const settings = Object.fromEntries(
            (db.all('SELECT setting_name, setting_value FROM settings') || [])
                .map((r) => [r.setting_name, r.setting_value]),
        );
        const enabled = isStoreTransfersEnabled(settings);
        res.json({
            success: true,
            enabled,
            customers: enabled ? await listTransferCustomers() : [],
            storeDate: getStoreDateStamp(),
        });
    }));

    server.get('/api/receiving/store-transfers', wrap(async (req, res) => {
        const session = requireReceivingAuth(req, res);
        if (!session) return;
        try {
            const rows = searchStoreTransfers(db, {
                q: req.query?.q,
                date: req.query?.date,
                limit: req.query?.limit,
            });
            res.json({ success: true, transfers: rows });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not search store transfers.');
        }
    }));

    server.post('/api/receiving/store-transfers', wrap(async (req, res) => {
        const session = requireReceivingAuth(req, res);
        if (!session) return;
        const b = req.body ?? {};
        try {
            const transfer = await createStoreTransfer(db, {
                customerName: b.customer_name,
                customerNumber: b.customer_number,
                storeDate: b.store_date || getStoreDateStamp(),
                actorName: session.name,
                lineItems: b.line_items || b.lineItems,
                storageType: b.storage_type,
                pallets: b.pallets,
                weightKg: b.weight_kg,
            });
            logManagerAudit(db, {
                req,
                session,
                action: 'store_transfer_created',
                targetType: 'store_transfers',
                targetId: transfer.transfer_id,
                summary: `Store transfer ${transfer.invoice_no} → ${transfer.customer_name} (${(transfer.line_items || []).length} lines)`,
                metadata: {
                    invoice_no: transfer.invoice_no,
                    customer_name: transfer.customer_name,
                    lines: (transfer.line_items || []).length,
                    pieces: transfer.pieces,
                },
            });
            if (typeof broadcastUpdate === 'function') {
                broadcastUpdate({ table: 'store_transfers', action: 'insert', data: transfer });
            }
            res.json({ success: true, transfer });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not create store transfer.');
        }
    }));

    server.get('/api/receiving/store-transfers/:transferId/download', wrap(async (req, res) => {
        const session = requireReceivingAuth(req, res);
        if (!session) return;
        try {
            const row = getStoreTransfer(db, req.params.transferId);
            if (!row) return fail(res, 404, 'Store transfer not found.');
            const kind = String(req.query?.doc || 'invoice').toLowerCase() === 'manifest'
                ? 'manifest'
                : 'invoice';
            const filePath = resolveTransferFilePath(row, kind);
            if (!filePath) {
                return fail(res, 404, kind === 'manifest'
                    ? 'Manifest file is missing.'
                    : 'Invoice spreadsheet is missing.');
            }
            const downloadName = kind === 'manifest' && row.manifest_file_name
                ? row.manifest_file_name
                : (row.file_name || `${row.invoice_no}.xlsx`);
            const legacyXls = /\.xls$/i.test(downloadName) && !/\.xlsx$/i.test(downloadName);
            const mime = legacyXls
                ? 'application/vnd.ms-excel'
                : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
            res.setHeader('Content-Type', mime);
            res.setHeader('Content-Disposition', `attachment; filename="${downloadName}"`);
            res.sendFile(filePath);
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not download store transfer.');
        }
    }));

    server.get('/api/receiving/day-log', wrap(async (req, res) => {
        const session = requireReceivingAuth(req, res);
        if (!session) return;
        try {
            const date = String(req.query?.date || getStoreDateStamp()).trim();
            const rows = listReceivingDayLog(db, date);
            res.json({ success: true, store_date: date, rows });
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not load receiving day log.');
        }
    }));

    server.post('/api/receiving/pallets', wrap(async (req, res) => {
        const session = requireReceivingAuth(req, res);
        if (!session) return;
        const b = req.body ?? {};
        const wantsCorrection = String(b.correction || b.force || req.query?.correction || '') === '1';
        if (wantsCorrection && !isManagerRole(session.role)) {
            fail(res, 403, 'Post-departure corrections require a manager.');
            return;
        }
        const allowAfterDeparted = wantsCorrection;
        const bodyStoreDate = String(b.store_date || '').trim();
        const storeDate = (/^\d{4}-\d{2}-\d{2}$/.test(bodyStoreDate) && allowAfterDeparted)
            ? bodyStoreDate
            : getStoreDateStamp();
        try {
            const pallet = addReceivingPallet(db, {
                expId: b.exp_id,
                storeDate,
                licensePlate: b.license_plate,
                department: b.department,
                tempC: b.temp_c,
                tempSpots: b.temp_spots,
                notes: b.notes,
                actorName: session.name,
                allowAfterDeparted,
            });
            if (allowAfterDeparted) {
                logManagerAudit(db, {
                    req,
                    session,
                    action: 'add_receiving_pallet_correction',
                    targetType: 'receiving_pallets',
                    targetId: pallet.pallet_id,
                    summary: `Added pallet ${pallet.license_plate} (${pallet.department}) post time-out`,
                    metadata: { exp_id: pallet.exp_id, store_date: pallet.store_date },
                });
            }
            if (typeof broadcastUpdate === 'function') {
                broadcastUpdate({ table: 'receiving_pallets', action: 'insert', data: pallet });
            }
            res.json({ success: true, pallet });
        } catch (e) {
            if (e.code === 'NEED_MULTI_SPOT' || e.needs_more_spots) {
                return res.status(e.status || 409).json({
                    error: e.message,
                    code: 'NEED_MULTI_SPOT',
                    needs_more_spots: true,
                });
            }
            fail(res, e.status || 500, e.message || 'Could not add pallet.');
        }
    }));

    server.patch('/api/receiving/pallets/:palletId', wrap(async (req, res) => {
        const session = requireReceivingAuth(req, res);
        if (!session) return;
        const b = req.body ?? {};
        try {
            const pallet = updateReceivingPallet(db, {
                palletId: req.params.palletId,
                expId: b.exp_id,
                licensePlate: b.license_plate,
                department: b.department,
                tempC: b.temp_c,
                tempSpots: b.temp_spots,
                notes: b.notes,
                actorName: session.name,
            });
            logManagerAudit(db, {
                req,
                session,
                action: 'correct_receiving_pallet',
                targetType: 'receiving_pallets',
                targetId: pallet.pallet_id,
                summary: `Corrected pallet ${pallet.license_plate} (${pallet.department})`,
                metadata: {
                    exp_id: pallet.exp_id,
                    department: pallet.department,
                    temp_c: pallet.temp_c,
                    in_range: pallet.in_range,
                },
            });
            if (typeof broadcastUpdate === 'function') {
                broadcastUpdate({ table: 'receiving_pallets', action: 'update', data: pallet });
            }
            res.json({ success: true, pallet });
        } catch (e) {
            if (e.code === 'NEED_MULTI_SPOT' || e.needs_more_spots) {
                return res.status(e.status || 409).json({
                    error: e.message,
                    code: 'NEED_MULTI_SPOT',
                    needs_more_spots: true,
                });
            }
            fail(res, e.status || 500, e.message || 'Could not update pallet.');
        }
    }));

    server.delete('/api/receiving/pallets/:palletId', wrap(async (req, res) => {
        const session = requireReceivingAuth(req, res);
        if (!session) return;
        try {
            const wantsCorrection = String(req.query?.force || req.body?.force || '') === '1'
                || String(req.query?.correction || '') === '1';
            if (wantsCorrection && !isManagerRole(session.role)) {
                fail(res, 403, 'Post-departure corrections require a manager.');
                return;
            }
            const allowAfterDeparted = wantsCorrection;
            const result = deleteReceivingPallet(db, req.params.palletId, req.query?.exp_id, {
                allowAfterDeparted,
            });
            if (allowAfterDeparted) {
                logManagerAudit(db, {
                    req,
                    session,
                    action: 'delete_receiving_pallet_correction',
                    targetType: 'receiving_pallets',
                    targetId: req.params.palletId,
                    summary: `Removed pallet ${req.params.palletId} (post time-out correction)`,
                });
            }
            if (typeof broadcastUpdate === 'function') {
                broadcastUpdate({ table: 'receiving_pallets', action: 'delete', id_col: 'pallet_id', id_val: req.params.palletId });
            }
            res.json(result);
        } catch (e) {
            fail(res, e.status || 500, e.message || 'Could not remove pallet.');
        }
    }));

    server.post('/api/receiving-log-correction', wrap(async (req, res) => {
        const session = requireSession(req, res, false);
        if (!session) return;
        // Any authenticated staff may correct times (same people who stamp TIME IN/OUT on /rec).

        const b = req.body ?? {};
        const expId = String(b.exp_id || '').trim();
        if (!expId) return fail(res, 400, 'exp_id is required.');

        let result;
        try {
            result = applyReceivingLogCorrection(db, {
                expId,
                arrivedAt: b.arrived_at,
                departedAt: b.departed_at,
                invoiceRef: b.invoice_ref,
                actorName: session.name,
            });
        } catch (e) {
            return fail(res, e.status || 400, e.message || 'Invalid receiving log correction.');
        }

        logManagerAudit(db, {
            req,
            session,
            action: 'correct_receiving_log',
            targetType: 'expected_orders',
            targetId: expId,
            summary: `Corrected receiving log for ${result.vendor || expId}`,
            metadata: {
                arrived_at: result.arrived_at,
                departed_at: result.departed_at,
                invoice_ref: result.invoice_ref,
                duration_mins: result.duration_mins,
            },
        });
        if (typeof broadcastUpdate === 'function') {
            broadcastUpdate({
                table: 'expected_orders',
                action: 'update',
                id_col: 'exp_id',
                id_val: expId,
                data: result,
            });
        }
        res.json({ success: true, ...result });
    }));
}

module.exports = { registerReceivingDockRoutes, TGP_STORAGE_CONFIRM_PROMPT };
