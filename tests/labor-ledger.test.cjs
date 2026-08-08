'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildLaborLedger, shiftDurationHours } = require('../src/lib/labor-ledger.cjs');

test('shiftDurationHours parses typical shift', () => {
    assert.equal(shiftDurationHours('09:00', '17:00'), 8);
    assert.equal(shiftDurationHours('22:00', '06:00'), 8);
});

test('buildLaborLedger compares scheduled vs committed', () => {
    const db = {
        get(sql, ...params) {
            if (sql.includes('staff_shifts WHERE shift_date')) {
                return null;
            }
            if (sql.includes('staff_shifts WHERE shift_date = ?')) {
                return null;
            }
            if (sql.includes('shift_order_history WHERE store_date')) {
                return { staff_count: 2, staff_roster: '["A","B"]' };
            }
            if (sql.includes('setting_value FROM settings')) {
                const key = params[0];
                if (key === 'Active_Manager') return { setting_value: 'Lead One' };
                if (key === 'Schedule_Role_Buckets') return { setting_value: '[]' };
                if (key === 'FIFO_Aisle_Assignments') return { setting_value: '[]' };
                if (key === 'Rhythm_Deferred') return { setting_value: '{}' };
                if (key === 'Order_Start' || key === 'Order_End') return { setting_value: '' };
            }
            if (sql.includes('FROM staff WHERE name')) {
                return { name: 'Lead One', role: 'Premium Clerk', shift_lead_eligible: 1 };
            }
            return null;
        },
        all(sql, ...params) {
            if (sql.includes('staff_shifts WHERE shift_date = ?')) {
                return [
                    { staff_name: 'Alice', start_time: '08:00', end_time: '16:00', role: 'Stock', department: 'Stock/Float' },
                    { staff_name: 'Bob', start_time: '08:00', end_time: '16:00', role: 'REC', department: 'REC' },
                ];
            }
            if (sql.includes('FROM staff WHERE active')) {
                return [
                    { name: 'Alice', role: 'Premium Clerk', shift_lead_eligible: 1 },
                    { name: 'Bob', role: 'Premium Clerk', shift_lead_eligible: 1 },
                    { name: 'Lead One', role: 'Premium Clerk', shift_lead_eligible: 1 },
                ];
            }
            if (sql.includes('FROM rhythm_tasks WHERE day')) {
                return [
                    { id: '1', detail: 'Store walk', est_mins: 30, zone: 'General' },
                    { id: '2', detail: 'TGP Order', est_mins: 0, zone: 'Order' },
                ];
            }
            if (sql.includes('FROM vendor_schedule')) return [{ vendor: 'Acme' }];
            if (sql.includes("FROM tasks") && sql.includes("status='Open'")) return [];
            return [];
        },
    };

    const ledger = buildLaborLedger(db, {
        storeDate: '2026-06-24',
        storeWeekday: 'Tuesday',
        orderDayBriefing: {
            is_order_day: true,
            expected_duration_minutes: 180,
            expected_staff: 3,
        },
        settings: { Active_Manager: 'Lead One', Hardware_Arrived: '0' },
        shiftSummary: { kill_dates_due: 1, orders_open: 0, vendors_pending: 0 },
        orderMetrics: { staff_count: 2, hardware_pieces: 0 },
    });

    assert.equal(ledger.scheduled.complement, 2);
    assert.equal(ledger.scheduled.person_hours, 16);
    assert.ok(ledger.committed.person_hours > 0);
    assert.equal(ledger.shift_lead, 'Lead One');
    assert.equal(ledger.schedule_vs_finish.mismatch, false);
    assert.ok(['surplus', 'tight', 'under', 'unknown'].includes(ledger.verdict));
});
