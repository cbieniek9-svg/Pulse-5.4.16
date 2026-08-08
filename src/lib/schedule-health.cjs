'use strict';

const {
    buildRhythmAssignContext,
    canonicalStaffName,
    classifyShift,
} = require('./rhythm-schedule-assign.cjs');
const { canBeActiveShiftLead, isShiftLeadEligibleStaff } = require('./shift-lead.cjs');
const { isStaffAliasIgnoredForSchedule, resolveStaffAlias } = require('./staff-name-aliases.cjs');
const { staffHasColumn } = require('./staff-permissions.cjs');

function readSetting(db, name) {
    const row = db.get('SELECT setting_value FROM settings WHERE setting_name = ?', name);
    return row?.setting_value || '';
}

function parseStoreTimeMinutes(timeStr) {
    const m = String(timeStr || '').match(/^(\d{1,2}):(\d{2})/);
    if (!m) return null;
    return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
}

function normKey(s) {
    return String(s || '').trim().toLowerCase();
}

/**
 * Schedule + shift-lead health signals for manager hub inbox.
 * @returns {object[]}
 */
function buildScheduleHealthExceptions(db, { storeDate, storeTime, settings } = {}) {
    if (!storeDate) return [];
    const mins = parseStoreTimeMinutes(storeTime);
    const afterOpen = mins != null && mins >= 6 * 60;
    if (!afterOpen) return [];

    const items = [];
    const shifts = db.all('SELECT * FROM staff_shifts WHERE shift_date = ? ORDER BY start_time, staff_name', storeDate) || [];
    const ctx = buildRhythmAssignContext(db, storeDate);
    const activeLead = String(settings?.Active_Manager || '').trim();

    if (!shifts.length) {
        items.push({
            kind: 'schedule_missing',
            color: '#f90',
            title: 'NO SCHEDULE FOR TODAY',
            detail: 'Import staff schedule in Settings → Staff — rhythm tasks stay Unassigned until schedule exists.',
            meta: storeDate,
        });
    }

    if (!activeLead) {
        items.push({
            kind: 'shift_lead_unset',
            color: '#f44',
            title: 'CONFIRM SHIFT LEAD',
            detail: 'Shift Roster → set Active Premium / Shift Lead for today (cleared at EOD).',
            meta: 'Not the store manager',
        });
    } else {
        let staff = null;
        try {
            staff = staffHasColumn(db, 'shift_lead_eligible')
                ? db.get('SELECT name, role, active, shift_lead_eligible FROM staff WHERE name = ?', activeLead)
                : db.get('SELECT name, role, active FROM staff WHERE name = ?', activeLead);
            if (staff && !staffHasColumn(db, 'shift_lead_eligible')) {
                staff.shift_lead_eligible = staff.role === 'Store Manager' ? 0 : 1;
            }
        } catch (_) {
            staff = null;
        }
        if (staff && !isShiftLeadEligibleStaff(staff)) {
            items.push({
                kind: 'shift_lead_ineligible',
                color: '#f44',
                title: 'INVALID SHIFT LEAD',
                detail: `${activeLead} cannot own the shift (Store Manager or excluded from shift lead).`,
                meta: 'Choose a premium shift lead',
            });
        } else if (!canBeActiveShiftLead(db, activeLead, storeDate)) {
            items.push({
                kind: 'shift_lead_unknown',
                color: '#f44',
                title: 'UNKNOWN SHIFT LEAD',
                detail: `${activeLead} is not an eligible premium/manager profile.`,
                meta: 'Shift Roster',
            });
        } else if (ctx.hasSchedule && !ctx.scheduledNames.has(normKey(activeLead))) {
            items.push({
                kind: 'shift_lead_not_scheduled',
                color: '#fa0',
                title: 'SHIFT LEAD NOT ON SCHEDULE',
                detail: `${activeLead} is set as shift lead but has no row on today's imported schedule.`,
                meta: 'Cover / confirm in Shift Roster',
            });
        }
    }

    const directoryKeys = new Set((ctx.directory || []).map((s) => normKey(s.name)));
    const unmatched = new Set();
    shifts.forEach((shift) => {
        const raw = String(shift.staff_name || '').trim();
        if (!raw) return;
        const alias = resolveStaffAlias(ctx.directory, raw);
        if (isStaffAliasIgnoredForSchedule(alias)) return;
        const canonical = canonicalStaffName(ctx.directory, raw);
        if (!canonical || !directoryKeys.has(normKey(canonical))) unmatched.add(raw);
    });
    if (unmatched.size) {
        items.push({
            kind: 'schedule_name_mismatch',
            color: '#fa0',
            title: 'SCHEDULE NAME MISMATCH',
            detail: `Import names not in staff directory: ${[...unmatched].slice(0, 4).join(', ')}${unmatched.size > 4 ? '…' : ''}`,
            meta: 'Fix spelling or add staff — auto-assign may miss',
        });
    }

    const roleRulesJson = readSetting(db, 'Schedule_Role_Buckets');
    const unclassified = shifts.filter((s) => {
        const alias = resolveStaffAlias(ctx.directory, s.staff_name);
        if (isStaffAliasIgnoredForSchedule(alias)) return false;
        return classifyShift(s.department, s.role, roleRulesJson) === 'other';
    });
    if (unclassified.length) {
        items.push({
            kind: 'schedule_unclassified',
            color: '#8cf',
            title: 'UNCLASSIFIED SCHEDULE ROWS',
            detail: `${unclassified.length} row(s) need rhythm role tags (Stock/Float, REC, Premium…) in Shift Roster.`,
            meta: unclassified.slice(0, 3).map((s) => s.staff_name).join(', '),
        });
    }

    const fifoMissing = [];
    (ctx.fifoRows || []).forEach((row) => {
        const staff = String(row?.staff || '').trim();
        if (!staff || !ctx.hasSchedule) return;
        const assignee = canonicalStaffName(ctx.directory, staff);
        if (!assignee || !ctx.scheduledNames.has(normKey(assignee))) fifoMissing.push(assignee || staff);
    });
    if (fifoMissing.length) {
        items.push({
            kind: 'fifo_not_scheduled',
            color: '#fa0',
            title: 'FIFO OWNER NOT SCHEDULED',
            detail: `${fifoMissing.slice(0, 3).join(', ')} — FIFO aisle tasks will not auto-assign today.`,
            meta: 'Settings → Store & TV → FIFO assignments',
        });
    }

    return items;
}

module.exports = { buildScheduleHealthExceptions, parseStoreTimeMinutes };
