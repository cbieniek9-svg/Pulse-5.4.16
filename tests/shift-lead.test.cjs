'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    canBeActiveShiftLead,
    listShiftLeadOptions,
    reconcileActiveManager,
} = require('../src/lib/shift-lead.cjs');

function mockDb({ settings = {}, staff = [], shifts = [], fifo = '[]' } = {}) {
    const liveSettings = { ...settings, FIFO_Aisle_Assignments: fifo };
    function settingNameFrom(sql, params) {
        if (params[0] != null) return params[0];
        const m = String(sql).match(/setting_name\s*=\s*'([^']+)'/i);
        return m?.[1];
    }
    return {
        get(sql, ...params) {
            if (/settings/i.test(sql) && /setting_name/i.test(sql)) {
                const name = settingNameFrom(sql, params);
                return liveSettings[name] != null ? { setting_value: liveSettings[name] } : undefined;
            }
            if (sql.includes('FROM staff WHERE name')) {
                return staff.find((s) => s.name === params[0]);
            }
            if (sql.includes("status='Open'")) return { c: 0 };
            return undefined;
        },
        all(sql, ...params) {
            if (/PRAGMA table_info\(staff\)/i.test(sql)) {
                return [
                    { name: 'name' },
                    { name: 'role' },
                    { name: 'active' },
                    { name: 'shift_lead_eligible' },
                ];
            }
            if (sql.includes('staff_shifts')) {
                if (sql.includes('shift_date = ?')) return shifts.filter((s) => s.shift_date === params[0]);
                return shifts;
            }
            if (sql.includes('staff_name_aliases')) return [];
            if (sql.includes('FROM staff')) return staff;
            return [];
        },
        run(sql, ...params) {
            if (sql.includes('Active_Manager') && sql.includes('UPDATE')) {
                liveSettings.Active_Manager = '';
            }
            if (/settings/i.test(sql) && params[0] != null && params[1] != null) {
                liveSettings[params[0]] = params[1];
            }
        },
    };
}

test('listShiftLeadOptions includes unscheduled eligible premiums when schedule exists', () => {
    const db = mockDb({
        staff: [
            { name: 'Ashley', role: 'Premium Clerk', active: 1, shift_lead_eligible: 1 },
            { name: 'Izzy', role: 'Premium Clerk', active: 1, shift_lead_eligible: 1 },
            { name: 'Sam', role: 'Clerk', active: 1, shift_lead_eligible: 0 },
        ],
        shifts: [{
            staff_name: 'Izzy',
            shift_date: '2026-06-27',
            department: 'PREMIUM',
            role: '',
            start_time: '07:00',
            end_time: '15:00',
        }],
    });
    const options = listShiftLeadOptions(db, '2026-06-27');
    assert.deepEqual(options, ['Ashley', 'Izzy']);
    assert.equal(canBeActiveShiftLead(db, 'Ashley', '2026-06-27'), true);
    assert.equal(canBeActiveShiftLead(db, 'Izzy', '2026-06-27'), true);
    assert.equal(canBeActiveShiftLead(db, 'Sam', '2026-06-27'), false);
});

test('listShiftLeadOptions ensureNames adds eligible self when missing from directory scan', () => {
    const db = mockDb({
        staff: [
            { name: 'Boss', role: 'Manager', active: 1, shift_lead_eligible: 1 },
        ],
        shifts: [{
            staff_name: 'Other',
            shift_date: '2026-06-27',
            department: 'STOCK',
            role: '',
        }],
    });
    const options = listShiftLeadOptions(db, '2026-06-27', { ensureNames: ['Boss'] });
    assert.ok(options.includes('Boss'));
});

test('reconcileActiveManager keeps eligible shift lead even when not on schedule', () => {
    const db = mockDb({
        settings: { Active_Manager: 'Ashley' },
        staff: [
            { name: 'Ashley', role: 'Premium Clerk', active: 1, shift_lead_eligible: 1 },
            { name: 'Izzy', role: 'Premium Clerk', active: 1, shift_lead_eligible: 1 },
        ],
        shifts: [{
            staff_name: 'Izzy',
            shift_date: '2026-06-27',
            department: 'PREMIUM',
            role: '',
            start_time: '07:00',
            end_time: '15:00',
        }],
    });
    assert.equal(reconcileActiveManager(db, '2026-06-27'), 'Ashley');
});

test('reconcileActiveManager does not clear ineligible lead unless clear:true', () => {
    const db = mockDb({
        settings: { Active_Manager: 'CorpSM' },
        staff: [
            { name: 'CorpSM', role: 'Store Manager', active: 1, shift_lead_eligible: 0 },
            { name: 'Izzy', role: 'Premium Clerk', active: 1, shift_lead_eligible: 1 },
        ],
        shifts: [{
            staff_name: 'Izzy',
            shift_date: '2026-06-27',
            department: 'PREMIUM',
            role: '',
            start_time: '07:00',
            end_time: '15:00',
        }],
    });
    assert.equal(reconcileActiveManager(db, '2026-06-27'), 'CorpSM');
    assert.equal(reconcileActiveManager(db, '2026-06-27', { clear: true }), '');
});

test('getActiveManagerStatus flags stale ineligible lead without writing', () => {
    const { getActiveManagerStatus } = require('../src/lib/shift-lead.cjs');
    const db = mockDb({
        settings: { Active_Manager: 'CorpSM' },
        staff: [
            { name: 'CorpSM', role: 'Store Manager', active: 1, shift_lead_eligible: 0 },
            { name: 'Izzy', role: 'Premium Clerk', active: 1, shift_lead_eligible: 1 },
        ],
        shifts: [{
            staff_name: 'Izzy',
            shift_date: '2026-06-27',
            department: 'PREMIUM',
            role: '',
            start_time: '07:00',
            end_time: '15:00',
        }],
    });
    const status = getActiveManagerStatus(db, '2026-06-27');
    assert.equal(status.value, 'CorpSM');
    assert.equal(status.eligible, false);
    assert.equal(status.stale, true);
});

test('listShiftLeadOptions falls back to all eligible premiums when no schedule imported', () => {
    const db = mockDb({
        staff: [
            { name: 'Ashley', role: 'Premium Clerk', active: 1, shift_lead_eligible: 1 },
            { name: 'Sam', role: 'Clerk', active: 1, shift_lead_eligible: 1 },
        ],
        shifts: [],
    });
    const options = listShiftLeadOptions(db, '2026-06-27');
    assert.deepEqual(options, ['Ashley']);
});
