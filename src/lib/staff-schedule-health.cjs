'use strict';

const {
    buildRhythmAssignContext,
    canonicalStaffName,
} = require('./rhythm-schedule-assign.cjs');
const { classifyShift, bucketLabel } = require('./schedule-role-buckets.cjs');
const { canBeActiveShiftLead, isShiftLeadEligibleStaff } = require('./shift-lead.cjs');
const {
    isStaffAliasIgnoredForSchedule,
    resolveStaffAlias,
    loadStaffNameAliases,
    attachStaffNameAliases,
} = require('./staff-name-aliases.cjs');

function normKey(s) {
    return String(s || '').trim().toLowerCase();
}

function readSetting(db, name) {
    try {
        const row = db.get('SELECT setting_value FROM settings WHERE setting_name = ?', name);
        return row?.setting_value || '';
    } catch (_) {
        return '';
    }
}

function countComplement(shifts, focusDate) {
    const names = new Set();
    (shifts || []).filter((s) => !focusDate || s.shift_date === focusDate).forEach((s) => {
        const n = String(s.staff_name || '').trim();
        if (n) names.add(normKey(n));
    });
    return names.size;
}

/**
 * Analyze parsed or stored shift rows before/after import.
 * @param {object} db
 * @param {object[]} shifts
 * @param {{ focusDate?: string, parseErrors?: string[] }} opts
 */
function analyzeScheduleShifts(db, shifts, { focusDate = '', parseErrors = [] } = {}) {
    const roleRulesJson = readSetting(db, 'Schedule_Role_Buckets');
    const ctxDate = focusDate || new Date().toISOString().slice(0, 10);
    const directory = buildRhythmAssignContext(db, ctxDate).directory || attachStaffNameAliases(
        [],
        loadStaffNameAliases(db),
    );
    const directoryKeys = new Set(directory.map((s) => normKey(s.name)));

    const unmatchedNames = [];
    const unclassifiedRows = [];
    const missingDepartmentRows = [];
    const ignoredRows = [];
    const bucketCounts = {};
    const dates = [...new Set((shifts || []).map((s) => s.shift_date).filter(Boolean))].sort();

    (shifts || []).forEach((shift) => {
        const rawName = String(shift.staff_name || '').trim();
        const alias = resolveStaffAlias(directory, rawName);
        if (isStaffAliasIgnoredForSchedule(alias)) {
            ignoredRows.push({ staff_name: rawName, reason: alias?.alias_type || 'ignored' });
            return;
        }

        const canonical = canonicalStaffName(directory, rawName);
        if (!canonical || !directoryKeys.has(normKey(canonical))) {
            unmatchedNames.push({ import_name: rawName, resolved: canonical || '' });
        }

        const bucket = classifyShift(shift.department, shift.role, roleRulesJson);
        bucketCounts[bucket] = (bucketCounts[bucket] || 0) + 1;

        const dept = String(shift.department || '').trim();
        const role = String(shift.role || '').trim();
        if (!dept && !role) {
            missingDepartmentRows.push({
                staff_name: rawName,
                shift_date: shift.shift_date,
            });
        }
        if (bucket === 'other' && (dept || role)) {
            unclassifiedRows.push({
                staff_name: rawName,
                shift_date: shift.shift_date,
                department: dept,
                role,
            });
        }
    });

    const uniqueUnmatched = [];
    const seen = new Set();
    unmatchedNames.forEach((row) => {
        const key = normKey(row.import_name);
        if (seen.has(key)) return;
        seen.add(key);
        uniqueUnmatched.push(row);
    });

    const focusCount = focusDate
        ? (shifts || []).filter((s) => s.shift_date === focusDate).length
        : 0;
    const complement = focusDate ? countComplement(shifts, focusDate) : countComplement(shifts);

    const issues = [];
    if (parseErrors.length) {
        issues.push({
            kind: 'parse_errors',
            severity: parseErrors.some((e) => /missing/i.test(e)) ? 'error' : 'warn',
            title: 'Import warnings',
            detail: parseErrors.slice(0, 5).join(' · '),
            count: parseErrors.length,
        });
    }
    if (!(shifts || []).length) {
        issues.push({
            kind: 'empty',
            severity: 'error',
            title: 'No shifts found',
            detail: 'Check file format, headers, and dates.',
            count: 0,
        });
    }
    if (uniqueUnmatched.length) {
        issues.push({
            kind: 'name_mismatch',
            severity: 'warn',
            title: 'Names not in staff directory',
            detail: uniqueUnmatched.slice(0, 4).map((r) => r.import_name).join(', '),
            count: uniqueUnmatched.length,
            names: uniqueUnmatched.map((r) => r.import_name),
        });
    }
    if (unclassifiedRows.length) {
        issues.push({
            kind: 'unclassified',
            severity: 'warn',
            title: 'Unclassified role tags',
            detail: `${unclassifiedRows.length} row(s) did not match role rules — fix department text or Today's shift roles.`,
            count: unclassifiedRows.length,
            rows: unclassifiedRows.slice(0, 8),
        });
    }
    if (missingDepartmentRows.length) {
        issues.push({
            kind: 'missing_department',
            severity: 'warn',
            title: 'Missing department/role',
            detail: `${missingDepartmentRows.length} row(s) have no department or role text.`,
            count: missingDepartmentRows.length,
        });
    }

    const hasError = issues.some((i) => i.severity === 'error');
    const hasWarn = issues.some((i) => i.severity === 'warn');
    const status = hasError ? 'error' : (hasWarn ? 'warning' : 'ok');

    return {
        status,
        ready: (shifts || []).length > 0 && !hasError,
        shift_count: (shifts || []).length,
        date_from: dates[0] || '',
        date_to: dates[dates.length - 1] || '',
        date_count: dates.length,
        focus_date: focusDate || '',
        focus_shift_count: focusCount,
        complement,
        bucket_counts: Object.fromEntries(
            Object.entries(bucketCounts).map(([k, v]) => [k, { count: v, label: bucketLabel(k) }]),
        ),
        unmatched_names: uniqueUnmatched,
        unclassified_rows: unclassifiedRows.slice(0, 12),
        missing_department_rows: missingDepartmentRows.slice(0, 12),
        ignored_rows: ignoredRows.slice(0, 8),
        parse_errors: parseErrors,
        issues,
    };
}

function buildStoredScheduleHealth(db, storeDate) {
    const shifts = db.all(
        'SELECT * FROM staff_shifts WHERE shift_date = ? ORDER BY start_time, staff_name',
        storeDate,
    ) || [];
    const settings = {
        Active_Manager: readSetting(db, 'Active_Manager'),
    };
    const analysis = analyzeScheduleShifts(db, shifts, { focusDate: storeDate });

    if (!shifts.length) {
        analysis.issues.unshift({
            kind: 'schedule_missing',
            severity: 'error',
            title: 'No schedule for today',
            detail: 'Import a schedule file to enable rhythm auto-assign.',
            count: 0,
        });
        analysis.status = 'error';
        analysis.ready = false;
    }

    const activeLead = String(settings.Active_Manager || '').trim();
    if (!activeLead) {
        analysis.issues.push({
            kind: 'shift_lead_unset',
            severity: 'warn',
            title: 'Shift lead not set',
            detail: 'Set Active Premium / Shift Lead on mobile Shift Roster.',
            count: 1,
        });
    } else {
        const staff = db.get('SELECT name, role, active, shift_lead_eligible FROM staff WHERE name = ?', activeLead);
        const ctx = buildRhythmAssignContext(db, storeDate);
        if (staff && !isShiftLeadEligibleStaff(staff)) {
            analysis.issues.push({
                kind: 'shift_lead_ineligible',
                severity: 'warn',
                title: 'Invalid shift lead',
                detail: `${activeLead} cannot own the shift.`,
                count: 1,
            });
        } else if (!canBeActiveShiftLead(db, activeLead, storeDate)) {
            analysis.issues.push({
                kind: 'shift_lead_unknown',
                severity: 'warn',
                title: 'Unknown shift lead',
                detail: `${activeLead} is not an eligible shift lead profile.`,
                count: 1,
            });
        } else if (ctx.hasSchedule && !ctx.scheduledNames.has(normKey(activeLead))) {
            analysis.issues.push({
                kind: 'shift_lead_not_scheduled',
                severity: 'warn',
                title: 'Shift lead not on schedule',
                detail: `${activeLead} has no row on today's imported schedule.`,
                count: 1,
            });
        }
    }

    if (analysis.issues.some((i) => i.severity === 'error')) analysis.status = 'error';
    else if (analysis.issues.some((i) => i.severity === 'warn')) analysis.status = 'warning';
    else analysis.status = 'ok';

    return {
        ...analysis,
        store_date: storeDate,
        active_shift_lead: activeLead,
    };
}

module.exports = {
    analyzeScheduleShifts,
    buildStoredScheduleHealth,
};
