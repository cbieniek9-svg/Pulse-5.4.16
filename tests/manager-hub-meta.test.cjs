'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildManagerHubMeta } = require('../src/lib/manager-hub-meta.cjs');

test('buildManagerHubMeta includes order weekly scorecard when history exists', () => {
    const db = {
        all(sql, ...params) {
            if (sql.includes('tasks WHERE status=\'Open\'')) return [];
            if (sql.includes('kill_dates')) return [];
            if (sql.includes('shift_order_history')) {
                return [{
                    store_date: '2026-05-10',
                    order_start: '2026-05-10T13:00:00.000Z',
                    order_end: '2026-05-10T21:00:00.000Z',
                    total_pieces: 800,
                    staff_count: 5,
                    actual_order_minutes: 480,
                }];
            }
            if (sql.includes('tasks') && sql.includes('Closed')) return [];
            if (sql.includes('FROM oos')) return [];
            if (sql.includes('vendor_schedule')) return [];
            if (sql.includes('expected_orders')) return [];
            if (sql.includes('COUNT')) return { c: 0 };
            return [];
        },
        get() { return { c: 0 }; },
    };

    const meta = buildManagerHubMeta(db, {
        today: '2026-05-19',
        clock: { storeWeekday: 'Monday', storeTime: '10:00' },
        kpis: {},
        settings: { Order_Start: '', Order_End: '' },
        cachedHeatMap: {},
        presenceConfig: { enabled: false, gateways: [], gateway_by_id: {}, staff_beacons: {}, cart_map: {}, order_gateway_ids: [], asset_mode: 'staff', mismatch_threshold: 2, allow_discovery: false, stale_minutes: 5, zone_window_minutes: 3, rssi_floor: -95 },
    });

    assert.ok(meta.order_weekly_scorecard);
    assert.ok(meta.order_weekly_scorecard.overall.order_days >= 1);
    assert.ok(Array.isArray(meta.report_actions));
});
