'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildScheduleHealthExceptions } = require('../src/lib/schedule-health.cjs');
const { isShiftLeadEligibleStaff, canBeActiveShiftLead } = require('../src/lib/shift-lead.cjs');

function mockDb({ settings = {}, staff = [], shifts = [], fifo = '[]' } = {}) {
    return {
        get(sql, ...params) {
            if (sql.includes('setting_name')) {
                const name = params[0];
                const map = { ...settings, FIFO_Aisle_Assignments: fifo };
                return map[name] != null ? { setting_value: map[name] } : undefined;
            }
            if (sql.includes('FROM staff WHERE name')) {
                return staff.find((s) => s.name === params[0]);
            }
            if (sql.includes("status='Open'")) return { c: 0 };
            return undefined;
        },
        all(sql, ...params) {
            if (sql.includes('staff_shifts')) {
                if (sql.includes('shift_date = ?')) return shifts.filter((s) => s.shift_date === params[0]);
                return shifts;
            }
            if (sql.includes('FROM staff')) return staff;
            return [];
        },
    };
}

test('isShiftLeadEligibleStaff excludes Store Manager and shift_lead_eligible=0', () => {
    assert.equal(isShiftLeadEligibleStaff({ name: 'SM', role: 'Store Manager', active: 1 }), false);
    assert.equal(isShiftLeadEligibleStaff({ name: 'P', role: 'Premium Clerk', active: 1 }), true);
    assert.equal(isShiftLeadEligibleStaff({ name: 'L', role: 'Manager', active: 1, shift_lead_eligible: 0 }), false);
});

test('buildScheduleHealthExceptions warns when shift lead unset after 06:00', () => {
    const db = mockDb({ settings: { Active_Manager: '' }, shifts: [] });
    const items = buildScheduleHealthExceptions(db, { storeDate: '2026-06-08', storeTime: '07:00', settings: {} });
    assert.ok(items.some((i) => i.kind === 'shift_lead_unset'));
    assert.ok(items.some((i) => i.kind === 'schedule_missing'));
});

test('buildScheduleHealthExceptions flags ineligible active shift lead', () => {
    const db = mockDb({
        settings: { Active_Manager: 'Pat' },
        staff: [{ name: 'Pat', role: 'Store Manager', active: 1, shift_lead_eligible: 0 }],
        shifts: [{ staff_name: 'Pat', shift_date: '2026-06-08', department: 'Premium', role: '', start_time: '07:00' }],
    });
    const items = buildScheduleHealthExceptions(db, {
        storeDate: '2026-06-08',
        storeTime: '07:30',
        settings: { Active_Manager: 'Pat' },
    });
    assert.ok(items.some((i) => i.kind === 'shift_lead_ineligible'));
});

test('canBeActiveShiftLead allows scheduled premium not in staff table shape', () => {
    const db = mockDb({
        staff: [{ name: 'Chris', role: 'Premium Clerk', active: 1, shift_lead_eligible: 1 }],
        shifts: [{ staff_name: 'Chris', shift_date: '2026-06-08', department: 'Premium', role: '', start_time: '07:00' }],
    });
    assert.equal(canBeActiveShiftLead(db, 'Chris', '2026-06-08'), true);
    assert.equal(canBeActiveShiftLead(db, 'Pat', '2026-06-08'), false);
});
