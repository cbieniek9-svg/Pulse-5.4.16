'use strict';

const crypto = require('crypto');
const {
    isStaffAliasExcludedFromImport,
    loadStaffNameAliases,
    resolveStaffAlias,
} = require('./staff-name-aliases.cjs');
const { dateStampFromParsedDate } = require('./store-time.cjs');
const { readSpreadsheetBuffer, sheetToObjects, excelSerialToDate } = require('./spreadsheet-read.cjs');
const MAX_SPREADSHEET_BYTES = 5 * 1024 * 1024;

const STAFF_SHIFT_HEADER_ALIASES = {
    staff_name: ['staff', 'staffname', 'employee', 'employeename', 'name', 'associate', 'teammember', 'team member'],
    shift_date: ['date', 'shiftdate', 'day', 'workdate', 'scheduledate', 'schedule date'],
    start_time: ['start', 'starttime', 'start time', 'in', 'timein', 'time in'],
    end_time: ['end', 'endtime', 'end time', 'out', 'timeout', 'time out'],
    role: ['role', 'position', 'job', 'jobcode', 'job code'],
    department: ['department', 'dept', 'area', 'zone'],
    notes: ['notes', 'note', 'comment', 'comments'],
};

function normalizeHeader(v) {
    return String(v ?? '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function normalizeDate(v, fallbackYear = '') {
    if (v === null || v === undefined || v === '') return '';
    if (v instanceof Date && !Number.isNaN(v.getTime())) {
        // UTC calendar day — local getters roll back a day west of UTC (e.g. America/Edmonton).
        return v.toISOString().slice(0, 10);
    }
    if (typeof v === 'number') {
        try {
            const d = excelSerialToDate(v);
            if (d instanceof Date && !Number.isNaN(d.getTime())) {
                return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
            }
        } catch (_) { /* fall through */ }
    }
    const raw = String(v).trim();
    const ymd = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);
    if (ymd) return `${ymd[1]}-${ymd[2].padStart(2, '0')}-${ymd[3].padStart(2, '0')}`;
    const mdy = raw.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
    if (mdy) {
        const y = mdy[3].length === 2 ? `20${mdy[3]}` : mdy[3];
        return `${y}-${mdy[1].padStart(2, '0')}-${mdy[2].padStart(2, '0')}`;
    }
    const dmy = raw.match(/^(\d{1,2})[- ]([A-Za-z]{3,9})$/);
    if (dmy && fallbackYear) {
        const t = Date.parse(`${dmy[2]} ${dmy[1]}, ${fallbackYear}`);
        if (!Number.isNaN(t)) return dateStampFromParsedDate(new Date(t));
    }
    const mdyText = raw.match(/^([A-Za-z]{3,9})[- ](\d{1,2})$/);
    if (mdyText && fallbackYear) {
        const t = Date.parse(`${mdyText[1]} ${mdyText[2]}, ${fallbackYear}`);
        if (!Number.isNaN(t)) return dateStampFromParsedDate(new Date(t));
    }
    if (fallbackYear && !/\b\d{4}\b/.test(raw)) {
        const t = Date.parse(`${raw}, ${fallbackYear}`);
        if (!Number.isNaN(t)) return dateStampFromParsedDate(new Date(t));
    }
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) return dateStampFromParsedDate(new Date(t));
    return '';
}

function normalizeTime(v) {
    if (v === null || v === undefined || v === '') return '';
    if (typeof v === 'number') {
        const total = Math.round((v % 1) * 24 * 60);
        const h = Math.floor(total / 60);
        const m = total % 60;
        return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
    }
    const raw = String(v).trim();
    const m = raw.match(/^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i);
    if (!m) return raw.slice(0, 20);
    let h = parseInt(m[1], 10);
    const min = parseInt(m[2] || '0', 10);
    const ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12;
    if (ap === 'am' && h === 12) h = 0;
    if (h > 23 || min > 59) return raw.slice(0, 20);
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

function parseCsvRows(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (quoted) {
            if (ch === '"' && next === '"') { cell += '"'; i++; }
            else if (ch === '"') quoted = false;
            else cell += ch;
        } else if (ch === '"') quoted = true;
        else if (ch === ',') { row.push(cell); cell = ''; }
        else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (ch !== '\r') cell += ch;
    }
    row.push(cell);
    if (row.some((c) => String(c).trim() !== '')) rows.push(row);
    return rows;
}

function rowsToShiftRecords(rows, sourceFile, importedAt, importedBy) {
    const weekly = rowsToWeeklyScheduleShiftRecords(rows, sourceFile, importedAt, importedBy);
    if (weekly.shifts.length || weekly.matched) return weekly;

    const nonEmpty = rows.filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
    if (!nonEmpty.length) return { shifts: [], errors: ['No rows found in schedule file.'] };
    const headers = nonEmpty[0].map(normalizeHeader);
    const findIdx = (field) => {
        const aliases = STAFF_SHIFT_HEADER_ALIASES[field].map(normalizeHeader);
        return headers.findIndex((h) => aliases.includes(h));
    };
    const idx = Object.fromEntries(Object.keys(STAFF_SHIFT_HEADER_ALIASES).map((k) => [k, findIdx(k)]));
    const errors = [];
    if (idx.staff_name < 0) errors.push('Missing staff/name column.');
    if (idx.shift_date < 0) errors.push('Missing date column.');
    if (errors.length) return { shifts: [], errors };
    const shifts = [];
    nonEmpty.slice(1).forEach((r, i) => {
        const staffName = String(r[idx.staff_name] ?? '').trim();
        const shiftDate = normalizeDate(r[idx.shift_date]);
        if (!staffName && !shiftDate) return;
        if (!staffName || !shiftDate) {
            errors.push(`Row ${i + 2}: staff name and date are required.`);
            return;
        }
        shifts.push({
            id: crypto.randomUUID(),
            staff_name: staffName,
            shift_date: shiftDate,
            start_time: idx.start_time >= 0 ? normalizeTime(r[idx.start_time]) : '',
            end_time: idx.end_time >= 0 ? normalizeTime(r[idx.end_time]) : '',
            role: idx.role >= 0 ? String(r[idx.role] ?? '').trim() : '',
            department: idx.department >= 0 ? String(r[idx.department] ?? '').trim() : '',
            notes: idx.notes >= 0 ? String(r[idx.notes] ?? '').trim() : '',
            source_file: sourceFile,
            imported_at: importedAt,
            imported_by: importedBy,
        });
    });
    return { shifts, errors };
}

function parseShiftRange(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (/^(off|na|n\/a|stat|vacation|sick|loa)$/i.test(raw)) return null;
    const m = raw.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*[-–]\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i);
    if (!m) return null;
    let sh = parseInt(m[1], 10);
    const sm = parseInt(m[2] || '0', 10);
    const sap = (m[3] || '').toLowerCase();
    let eh = parseInt(m[4], 10);
    const em = parseInt(m[5] || '0', 10);
    const eap = (m[6] || '').toLowerCase();
    if (sap === 'pm' && sh < 12) sh += 12;
    if (sap === 'am' && sh === 12) sh = 0;
    if (eap === 'pm' && eh < 12) eh += 12;
    if (eap === 'am' && eh === 12) eh = 0;
    if (!sap && !eap) {
        if (sh >= 7 && sh <= 11 && eh <= 8) eh += 12;
        if (sh === 12 && eh <= 8) eh += 12;
    }
    if (sh > 23 || eh > 23 || sm > 59 || em > 59) return null;
    return {
        start: `${String(sh).padStart(2, '0')}:${String(sm).padStart(2, '0')}`,
        end: `${String(eh).padStart(2, '0')}:${String(em).padStart(2, '0')}`,
    };
}

function rowsToWeeklyScheduleShiftRecords(rows, sourceFile, importedAt, importedBy) {
    const nonEmpty = rows.filter((r) => Array.isArray(r) && r.some((c) => String(c ?? '').trim() !== ''));
    const headerIdx = nonEmpty.findIndex((r) =>
        String(r[0] ?? '').trim().toLowerCase() === 'center store'
        && ['sunday', 'monday', 'tuesday'].some((d) => r.some((c) => String(c ?? '').trim().toLowerCase() === d))
    );
    if (headerIdx < 1) return { shifts: [], errors: [], matched: false };

    const header = nonEmpty[headerIdx];
    const dayCols = [];
    header.forEach((cell, idx) => {
        const day = String(cell ?? '').trim();
        if (/^(Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday)$/i.test(day)) dayCols.push({ col: idx, day });
    });
    if (dayCols.length < 7) return { shifts: [], errors: ['Weekly schedule detected but day columns were incomplete.'], matched: true };

    const weekEndingRow = nonEmpty.find((r) => r.some((c) => /for week ending/i.test(String(c ?? '')))) || [];
    const weekEndingCell = weekEndingRow.find((c) => normalizeDate(c)) || weekEndingRow.find((c) => /,\s*\d{4}/.test(String(c ?? '')));
    const weekEnding = normalizeDate(weekEndingCell);
    const fallbackYear = weekEnding ? weekEnding.slice(0, 4) : String(new Date().getFullYear());
    const dateRow = nonEmpty[headerIdx - 1] || [];
    const datesByCol = Object.fromEntries(dayCols.map(({ col }) => [col, normalizeDate(dateRow[col], fallbackYear)]));

    const errors = [];
    const shifts = [];
    const ignoredNames = new Set(['sick/vacation', 'stat/shift premium', '1.5x ot/2x ot', 'centre store', 'center store', '']);
    for (let i = headerIdx + 1; i < nonEmpty.length; i++) {
        const row = nonEmpty[i];
        const name = String(row[0] ?? '').trim();
        if (ignoredNames.has(name.toLowerCase()) || name.startsWith('Week Ending:')) continue;
        const hasShift = dayCols.some(({ col }) => parseShiftRange(row[col]));
        if (!hasShift) continue;

        const roleRow = nonEmpty[i + 1] || [];
        const role = String(roleRow[0] ?? '').trim();
        dayCols.forEach(({ col, day }) => {
            const range = parseShiftRange(row[col]);
            if (!range) return;
            const shiftDate = datesByCol[col];
            if (!shiftDate) {
                errors.push(`${name} ${day}: could not determine date.`);
                return;
            }
            shifts.push({
                id: crypto.randomUUID(),
                staff_name: name,
                shift_date: shiftDate,
                start_time: range.start,
                end_time: range.end,
                role,
                department: String(roleRow[col] ?? '').trim(),
                notes: `${day} imported from weekly schedule`,
                source_file: sourceFile,
                imported_at: importedAt,
                imported_by: importedBy,
            });
        });
    }
    return { shifts, errors, matched: true };
}

async function extractShiftsFromUpload(db, filename, contentBase64, importedBy = 'preview') {
    const parsed = await parseStaffScheduleUpload(filename, contentBase64);
    if (parsed.errors.length) {
        return { shifts: [], errors: parsed.errors, safeName: parsed.safeName, filename: parsed.safeName };
    }
    const importedAt = new Date().toISOString();
    const parsedGroups = parsed.sheetRows
        ? Object.entries(parsed.sheetRows).map(([sheetName, rows]) =>
            rowsToShiftRecords(rows, `${parsed.safeName}:${sheetName}`, importedAt, importedBy))
        : [rowsToShiftRecords(parsed.rows, parsed.safeName, importedAt, importedBy)];

    // Resolve aliases once instead of per row, and drop names flagged as non-floor
    // (file maintenance / departed) so they never reach staff_shifts.
    const aliases = loadStaffNameAliases(db);
    const shifts = [];
    const skippedCounts = new Map();
    parsedGroups.flatMap((g) => g.shifts || []).forEach((row) => {
        const rawName = String(row.staff_name || '').trim();
        const alias = resolveStaffAlias(aliases, rawName);
        if (isStaffAliasExcludedFromImport(alias)) {
            const key = `${rawName}|${alias.alias_type}`;
            const prev = skippedCounts.get(key);
            if (prev) prev.rows += 1;
            else skippedCounts.set(key, { staff_name: rawName, reason: alias.alias_type, rows: 1 });
            return;
        }
        const staffName = (alias?.alias_type === 'alias' && alias.target_name)
            ? alias.target_name
            : rawName;
        shifts.push({ ...row, staff_name: staffName });
    });

    const errors = parsedGroups.flatMap((g) => g.errors || []);
    const dates = shifts.map((s) => s.shift_date).filter(Boolean).sort();
    return {
        shifts,
        errors,
        skipped: [...skippedCounts.values()],
        safeName: parsed.safeName,
        filename: parsed.safeName,
        date_from: dates[0] || '',
        date_to: dates[dates.length - 1] || '',
    };
}

async function parseStaffScheduleUpload(filename, contentBase64) {
    const safeName = String(filename || '').replace(/[^a-zA-Z0-9._ -]/g, '').slice(0, 120) || 'schedule';
    const buf = Buffer.from(String(contentBase64 || ''), 'base64');
    if (!buf.length) return { safeName, rows: [], errors: ['Empty upload.'] };
    if (buf.length > MAX_SPREADSHEET_BYTES) return { safeName, rows: [], errors: ['Upload is too large. Maximum spreadsheet size is 5 MB.'] };
    if (/\.csv$/i.test(safeName)) return { safeName, rows: parseCsvRows(buf.toString('utf8')), errors: [] };
    if (/\.xlsx?$/i.test(safeName)) {
        try {
            const wb = await readSpreadsheetBuffer(buf, safeName);
            if (!wb.sheets.length) return { safeName, rows: [], errors: ['Excel file has no sheets.'] };
            const scheduleSheets = wb.sheets.filter((sheet) => /^WE\s+/i.test(sheet.name));
            const sheets = scheduleSheets.length ? scheduleSheets : [wb.sheets[0]];
            const sheetRows = Object.fromEntries(sheets.map((sheet) => [
                sheet.name,
                sheetToObjects(sheet, { header: 1 })
                    .map((row) => (Array.isArray(row) ? row : []).map((c) => (c == null ? '' : c)))
                    .filter((row) => row.some((c) => c !== '')),
            ]));
            return { safeName, rows: sheetRows[sheets[0].name] || [], sheetRows, errors: [] };
        } catch (e) {
            return { safeName, rows: [], errors: [`Could not parse Excel file: ${e.message}`] };
        }
    }
    return { safeName, rows: [], errors: ['Upload must be a .xlsx, .xls, or .csv file.'] };
}

module.exports = {
    normalizeDate,
    parseStaffScheduleUpload,
    rowsToShiftRecords,
    extractShiftsFromUpload,
};
