'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { analyzeScheduleShifts, buildStoredScheduleHealth } = require('../src/lib/staff-schedule-health.cjs');

function mockDb(overrides = {}) {
    const settings = new Map(Object.entries(overrides.settings || {
        Schedule_Role_Buckets: '[]',
        Active_Manager: 'Alex',
    }));
    const staff = overrides.staff || [
        { name: 'Alex', role: 'Premium Clerk', active: 1, shift_lead_eligible: 1 },
        { name: 'Sam', role: 'Clerk', active: 1, shift_lead_eligible: 0 },
    ];
    const staffShifts = overrides.staff_shifts || [];
    const aliases = overrides.staff_name_aliases || [];

    return {
        get(sql, ...params) {
            if (sql.includes('setting_value FROM settings')) {
                return { setting_value: settings.get(params[0]) || '' };
            }
            if (sql.includes('FROM staff WHERE name')) {
                return staff.find((s) => s.name === params[0]) || null;
            }
            if (sql.includes('FROM staff WHERE active')) {
                return staff[0] || null;
            }
            if (sql.includes('staff_shifts WHERE shift_date = ?') && !sql.includes('ORDER')) {
                return staffShifts.filter((s) => s.shift_date === params[0]);
            }
            if (sql.includes('rhythm_tasks') && sql.includes('TGP Order')) return null;
            if (sql.includes('Order_Start')) return null;
            return null;
        },
        all(sql, ...params) {
            if (sql.includes('FROM staff WHERE active')) return staff;
            if (sql.includes('staff_shifts WHERE shift_date')) {
                return staffShifts.filter((s) => s.shift_date === params[0]);
            }
            if (sql.includes('staff_name_aliases')) return aliases;
            if (sql.includes('vendor_schedule')) return [];
            if (sql.includes('FIFO')) return [];
            return [];
        },
        exec() {},
    };
}

test('analyzeScheduleShifts flags unmatched names and unclassified rows', () => {
    const db = mockDb();
    const analysis = analyzeScheduleShifts(db, [
        {
            staff_name: 'Unknown Person',
            shift_date: '2026-06-26',
            department: 'Mystery Dept',
            role: '',
        },
        {
            staff_name: 'Sam',
            shift_date: '2026-06-26',
            department: 'REC',
            role: '',
        },
    ], { focusDate: '2026-06-26' });

    assert.equal(analysis.shift_count, 2);
    assert.equal(analysis.unmatched_names.length, 1);
    assert.equal(analysis.unmatched_names[0].import_name, 'Unknown Person');
    assert.equal(analysis.bucket_counts.rec.count, 1);
    assert.equal(analysis.status, 'warning');
    assert.equal(analysis.ready, true);
});

test('buildStoredScheduleHealth reports missing schedule for today', () => {
    const db = mockDb({ staff_shifts: [] });
    const health = buildStoredScheduleHealth(db, '2026-06-26');
    assert.equal(health.status, 'error');
    assert.ok(health.issues.some((i) => i.kind === 'schedule_missing'));
});

test('buildStoredScheduleHealth ok when schedule and names match', () => {
    const db = mockDb({
        staff_shifts: [
            { staff_name: 'Sam', shift_date: '2026-06-26', department: 'REC', role: '', start_time: '09:00' },
            { staff_name: 'Alex', shift_date: '2026-06-26', department: 'Premium', role: '', start_time: '08:00' },
        ],
    });
    const health = buildStoredScheduleHealth(db, '2026-06-26');
    assert.equal(health.focus_shift_count, 2);
    assert.equal(health.complement, 2);
    assert.ok(['ok', 'warning'].includes(health.status));
});
