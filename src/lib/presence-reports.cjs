'use strict';

const { buildPresenceBoard } = require('./presence-engine.cjs');
const { buildGatewayRollup } = require('./presence-analytics.cjs');

function buildPresenceReportSummary(db, config, { reportDate, isLiveToday = false }) {
    if (!config?.enabled) {
        return { enabled: false, message: 'BLE presence disabled' };
    }

    const snapshots = db.all(`
        SELECT id, store_date, order_start, snapshot_at, anchor_counts, inferred_staff,
               staff_names, source, asset_mode, asset_details
        FROM order_presence_snapshots
        WHERE store_date = ?
        ORDER BY snapshot_at DESC
        LIMIT 5
    `, reportDate).map((row) => {
        let staff_names = [];
        let anchor_counts = {};
        let asset_details = null;
        try { staff_names = JSON.parse(row.staff_names || '[]'); } catch (_) { /* ignore */ }
        try { anchor_counts = JSON.parse(row.anchor_counts || '{}'); } catch (_) { /* ignore */ }
        try { asset_details = JSON.parse(row.asset_details || 'null'); } catch (_) { /* ignore */ }
        return { ...row, staff_names, anchor_counts, asset_details };
    });

    const live = isLiveToday ? buildPresenceBoard(db, config) : null;
    const rollup = buildGatewayRollup(db, config, { sinceMinutes: 24 * 60 });

    return {
        enabled: true,
        report_date: reportDate,
        asset_mode: config.asset_mode,
        snapshots,
        latest_snapshot: snapshots[0] || null,
        live_board: live,
        gateway_rollup_24h: rollup,
        zone_occupancy: live?.analytics?.zone_occupancy || [],
        disclaimer: 'BLE is advisory only — FINISH headcount and shift archive remain source of truth.',
        architecture_note: 'Target: smart carts broadcast · dumb aisle receivers relay · GW-RECV hub ingests.',
    };
}

module.exports = { buildPresenceReportSummary };
