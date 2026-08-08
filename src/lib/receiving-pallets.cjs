'use strict';

const { isTgpVendor } = require('./receiving-flow.cjs');

const TGP_STORAGE_CONFIRM_PROMPT = 'Have you finished receiving the truck and all perishable items stored properly?';

/** Paper form departments — temp rules follow storage class. */
const PALLET_DEPARTMENTS = Object.freeze([
    { id: 'produce', label: 'Produce', storage: 'refrigerated', requires_temp: true },
    { id: 'produce_ambient', label: 'Produce (Ambient)', storage: 'ambient', requires_temp: false },
    { id: 'grocery', label: 'Perishables', storage: 'refrigerated', requires_temp: true },
    { id: 'dry_grocery', label: 'Dry Grocery', storage: 'ambient', requires_temp: false },
    { id: 'dairy', label: 'Dairy', storage: 'refrigerated', requires_temp: true },
    { id: 'deli', label: 'Deli', storage: 'refrigerated', requires_temp: true },
    { id: 'meat', label: 'Meat', storage: 'refrigerated', requires_temp: true },
    { id: 'bakery', label: 'Bakery', storage: 'refrigerated', requires_temp: true },
    { id: 'frozen', label: 'Frozen', storage: 'frozen', requires_temp: true },
    { id: 'other_refrigerated', label: 'Other Refrigerated', storage: 'refrigerated', requires_temp: true },
]);

const DEPARTMENT_BY_ID = Object.freeze(Object.fromEntries(PALLET_DEPARTMENTS.map((d) => [d.id, d])));

function departmentMeta(departmentId) {
    const id = String(departmentId || '').trim().toLowerCase();
    return DEPARTMENT_BY_ID[id] || null;
}

function roundTemp(n) {
    return Math.round(Number(n) * 10) / 10;
}

function departmentRequiresTemp(departmentId) {
    const dept = departmentMeta(departmentId);
    return dept ? dept.requires_temp !== false : true;
}

function evaluatePalletTemp(departmentId, tempCValue) {
    const dept = departmentMeta(departmentId);
    if (!dept) {
        return { valid: false, in_range: false, storage: '', reason: 'Unknown department.' };
    }
    const temp = Number(tempCValue);
    if (!Number.isFinite(temp)) {
        if (dept.requires_temp === false) {
            return { valid: true, in_range: true, storage: dept.storage, reason: '' };
        }
        return { valid: false, in_range: false, storage: dept.storage, reason: 'Temperature is required.' };
    }
    if (dept.storage === 'ambient') {
        const inRange = temp > 0;
        return {
            valid: true,
            in_range: inRange,
            storage: dept.storage,
            reason: inRange ? '' : 'Dry grocery must be above freezing (above 0°C).',
        };
    }
    if (dept.storage === 'frozen') {
        const inRange = temp <= -18;
        return {
            valid: true,
            in_range: inRange,
            storage: dept.storage,
            reason: inRange ? '' : 'Frozen pallets must be -18°C or below.',
        };
    }
    const inRange = temp >= 1 && temp <= 4;
    return {
        valid: true,
        in_range: inRange,
        storage: dept.storage,
        reason: inRange ? '' : 'Refrigerated pallets must be 1–4°C.',
    };
}

/**
 * Resolve a single reading or a 3-spot average for cold/frozen OOR checks.
 * @returns {{ temp_c, spots, in_range, storage, needs_more_spots?, reason? }}
 */
function resolvePalletTemperature(departmentId, tempCValue, tempSpots) {
    const dept = departmentMeta(departmentId);
    if (!dept) {
        return { valid: false, needs_more_spots: false, reason: 'Unknown department.', spots: [], temp_c: null, in_range: false, storage: '' };
    }

    let spots = Array.isArray(tempSpots)
        ? tempSpots.map((v) => Number(v)).filter((n) => Number.isFinite(n))
        : [];
    const primaryTemp = tempCValue === '' || tempCValue == null ? NaN : Number(tempCValue);
    if (!spots.length && Number.isFinite(primaryTemp)) {
        spots = [primaryTemp];
    }
    spots = spots.map(roundTemp);

    if (!spots.length) {
        if (dept.requires_temp === false) {
            return {
                valid: true,
                needs_more_spots: false,
                reason: '',
                spots: [],
                temp_c: null,
                in_range: true,
                storage: dept.storage,
            };
        }
        return {
            valid: false,
            needs_more_spots: false,
            reason: 'Temperature is required.',
            spots: [],
            temp_c: null,
            in_range: false,
            storage: dept.storage,
        };
    }

    // Dry grocery: temp optional; if provided, validate above freezing.
    if (dept.requires_temp === false) {
        const temp = spots[0];
        const evalResult = evaluatePalletTemp(dept.id, temp);
        return {
            valid: evalResult.valid,
            needs_more_spots: false,
            reason: evalResult.reason,
            spots: Number.isFinite(temp) ? [temp] : [],
            temp_c: Number.isFinite(temp) ? temp : null,
            in_range: evalResult.in_range,
            storage: dept.storage,
        };
    }

    if (spots.length === 1) {
        const evalResult = evaluatePalletTemp(dept.id, spots[0]);
        if (evalResult.in_range) {
            return {
                valid: true,
                needs_more_spots: false,
                reason: '',
                spots,
                temp_c: spots[0],
                in_range: true,
                storage: dept.storage,
            };
        }
        return {
            valid: false,
            needs_more_spots: true,
            reason: `${evalResult.reason} Take temperatures from 2 other spots on this pallet; we will average all three.`,
            spots,
            temp_c: spots[0],
            in_range: false,
            storage: dept.storage,
        };
    }

    if (spots.length !== 3) {
        return {
            valid: false,
            needs_more_spots: true,
            reason: 'Enter exactly three spot temperatures (first reading plus two more).',
            spots,
            temp_c: null,
            in_range: false,
            storage: dept.storage,
        };
    }

    const avg = roundTemp((spots[0] + spots[1] + spots[2]) / 3);
    const evalAvg = evaluatePalletTemp(dept.id, avg);
    return {
        valid: true,
        needs_more_spots: false,
        reason: evalAvg.in_range ? '' : evalAvg.reason,
        spots,
        temp_c: avg,
        in_range: evalAvg.in_range,
        storage: dept.storage,
    };
}

function formatSpotChecks(row) {
    const s1 = row.temp_spot_1;
    const s2 = row.temp_spot_2;
    const s3 = row.temp_spot_3;
    const spots = [s1, s2, s3].filter((n) => n != null && Number.isFinite(Number(n))).map((n) => roundTemp(n));
    if (spots.length >= 3) {
        const avg = row.temp_c != null ? roundTemp(row.temp_c) : roundTemp((spots[0] + spots[1] + spots[2]) / 3);
        return `${spots[0]} / ${spots[1]} / ${spots[2]} → avg ${avg}`;
    }
    if (spots.length === 1) {
        return `${spots[0]}°C`;
    }
    if (row.temp_c != null && Number.isFinite(Number(row.temp_c))) return `${roundTemp(row.temp_c)}°C`;
    return '—';
}

/** Split concatenated scans into space-separated plates (each plate starts with a letter). */
function formatLicensePlatesInput(value) {
    const raw = String(value || '').toUpperCase().replace(/\s+/g, '');
    if (!raw) return '';
    return raw.replace(/([0-9])(?=[A-Z])/g, '$1 ').replace(/\s+/g, ' ').trim();
}

function normalizeLicensePlate(value) {
    return formatLicensePlatesInput(value).slice(0, 80);
}

function listPalletsForExp(db, expId) {
    try {
        return db.all(`
            SELECT pallet_id, exp_id, store_date, seq_num, license_plate, department,
                   temp_c, temp_spot_1, temp_spot_2, temp_spot_3, in_range, notes, captured_at, captured_by
            FROM receiving_pallets
            WHERE exp_id = ?
            ORDER BY seq_num ASC, captured_at ASC
        `, expId) || [];
    } catch (_) {
        try {
            return db.all(`
                SELECT pallet_id, exp_id, store_date, seq_num, license_plate, department,
                       temp_c, in_range, notes, captured_at, captured_by
                FROM receiving_pallets
                WHERE exp_id = ?
                ORDER BY seq_num ASC, captured_at ASC
            `, expId) || [];
        } catch (__) {
            return [];
        }
    }
}

function countPalletsForExp(db, expId) {
    try {
        return Number(db.get('SELECT COUNT(*) AS c FROM receiving_pallets WHERE exp_id = ?', expId)?.c || 0);
    } catch (_) {
        return 0;
    }
}

function nextPalletSeq(db, expId) {
    const row = db.get('SELECT MAX(seq_num) AS m FROM receiving_pallets WHERE exp_id = ?', expId);
    return Number(row?.m || 0) + 1;
}

function addReceivingPallet(db, {
    expId,
    storeDate,
    licensePlate,
    department,
    tempC,
    tempSpots,
    notes,
    actorName,
    capturedAt,
    allowAfterDeparted = false,
}) {
    const plate = normalizeLicensePlate(licensePlate);
    if (!plate) {
        const err = new Error('License plate is required.');
        err.status = 400;
        throw err;
    }
    const dept = departmentMeta(department);
    if (!dept) {
        const err = new Error('Select a department.');
        err.status = 400;
        throw err;
    }

    const resolved = resolvePalletTemperature(dept.id, tempC, tempSpots);
    if (resolved.needs_more_spots) {
        const err = new Error(resolved.reason || 'Take two more spot temperatures.');
        err.status = 409;
        err.code = 'NEED_MULTI_SPOT';
        throw err;
    }
    if (!resolved.valid || (resolved.temp_c == null && departmentRequiresTemp(dept.id))) {
        const err = new Error(resolved.reason || 'Invalid temperature.');
        err.status = 400;
        throw err;
    }

    const order = db.get('SELECT exp_id, vendor, arrived, departed_at FROM expected_orders WHERE exp_id = ?', expId);
    if (!order) {
        const err = new Error('Delivery not found.');
        err.status = 404;
        throw err;
    }
    if (!order.arrived) {
        const err = new Error('Delivery must be timed in before logging pallets.');
        err.status = 409;
        throw err;
    }
    if (order.departed_at && !allowAfterDeparted) {
        const err = new Error('Delivery must be on dock to log pallets.');
        err.status = 409;
        throw err;
    }
    if (!isTgpVendor(order.vendor)) {
        const err = new Error('Pallet intake is only used for TGP deliveries.');
        err.status = 400;
        throw err;
    }
    const palletId = `PLT-${expId}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const seq = nextPalletSeq(db, expId);
    const ts = capturedAt || new Date().toISOString();
    const spot1 = resolved.spots[0] ?? null;
    const spot2 = resolved.spots.length >= 3 ? resolved.spots[1] : null;
    const spot3 = resolved.spots.length >= 3 ? resolved.spots[2] : null;

    try {
        db.run(`
            INSERT INTO receiving_pallets (
                pallet_id, exp_id, store_date, seq_num, license_plate, department,
                temp_c, temp_spot_1, temp_spot_2, temp_spot_3, in_range, notes, captured_at, captured_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        palletId,
        expId,
        storeDate,
        seq,
        plate,
        dept.id,
        resolved.temp_c,
        spot1,
        spot2,
        spot3,
        resolved.in_range ? 1 : 0,
        String(notes || '').trim().slice(0, 200),
        ts,
        actorName);
    } catch (e) {
        // Pre-migration fallback
        if (!String(e.message || e).includes('no such column')) throw e;
        db.run(`
            INSERT INTO receiving_pallets (
                pallet_id, exp_id, store_date, seq_num, license_plate, department,
                temp_c, in_range, notes, captured_at, captured_by
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        palletId,
        expId,
        storeDate,
        seq,
        plate,
        dept.id,
        resolved.temp_c,
        resolved.in_range ? 1 : 0,
        String(notes || '').trim().slice(0, 200),
        ts,
        actorName);
    }

    return {
        pallet_id: palletId,
        exp_id: expId,
        store_date: storeDate,
        seq_num: seq,
        license_plate: plate,
        department: dept.id,
        department_label: dept.label,
        temp_c: resolved.temp_c,
        temp_spot_1: spot1,
        temp_spot_2: spot2,
        temp_spot_3: spot3,
        spot_checks: formatSpotChecks({
            temp_c: resolved.temp_c,
            temp_spot_1: spot1,
            temp_spot_2: spot2,
            temp_spot_3: spot3,
        }),
        in_range: resolved.in_range,
        notes: String(notes || '').trim().slice(0, 200),
        captured_at: ts,
        captured_by: actorName,
    };
}

function deleteReceivingPallet(db, palletId, expId, { allowAfterDeparted = false } = {}) {
    const row = db.get('SELECT pallet_id, exp_id FROM receiving_pallets WHERE pallet_id = ?', palletId);
    if (!row) {
        const err = new Error('Pallet not found.');
        err.status = 404;
        throw err;
    }
    if (expId && row.exp_id !== expId) {
        const err = new Error('Pallet does not belong to this delivery.');
        err.status = 400;
        throw err;
    }
    const order = db.get('SELECT departed_at FROM expected_orders WHERE exp_id = ?', row.exp_id);
    if (order?.departed_at && !allowAfterDeparted) {
        const err = new Error('Cannot remove pallets after time out.');
        err.status = 409;
        throw err;
    }
    db.run('DELETE FROM receiving_pallets WHERE pallet_id = ?', palletId);
    return { success: true, pallet_id: palletId };
}

/**
 * Correct an existing pallet (plate / dept / temps), including after time out.
 * Re-runs range evaluation so Produce Ambient vs chilled Produce is honest.
 */
function updateReceivingPallet(db, {
    palletId,
    expId,
    licensePlate,
    department,
    tempC,
    tempSpots,
    notes,
    actorName,
}) {
    const existing = db.get('SELECT * FROM receiving_pallets WHERE pallet_id = ?', palletId);
    if (!existing) {
        const err = new Error('Pallet not found.');
        err.status = 404;
        throw err;
    }
    if (expId && existing.exp_id !== expId) {
        const err = new Error('Pallet does not belong to this delivery.');
        err.status = 400;
        throw err;
    }

    const dept = departmentMeta(department ?? existing.department);
    if (!dept) {
        const err = new Error('Unknown department.');
        err.status = 400;
        throw err;
    }

    const plate = normalizeLicensePlate(
        licensePlate !== undefined ? licensePlate : existing.license_plate,
    );
    if (!plate) {
        const err = new Error('License plate is required.');
        err.status = 400;
        throw err;
    }

    const nextTemp = tempC !== undefined ? tempC : existing.temp_c;
    let spots = tempSpots;
    if (!Array.isArray(spots) || !spots.length) {
        if (
            existing.temp_spot_1 != null
            && existing.temp_spot_2 != null
            && existing.temp_spot_3 != null
            && tempC === undefined
        ) {
            spots = [existing.temp_spot_1, existing.temp_spot_2, existing.temp_spot_3];
        }
    }

    const resolved = resolvePalletTemperature(dept.id, nextTemp, spots);
    if (resolved.needs_more_spots) {
        const err = new Error(resolved.reason || 'Take two more spot temperatures.');
        err.status = 409;
        err.code = 'NEED_MULTI_SPOT';
        err.needs_more_spots = true;
        throw err;
    }
    if (!resolved.valid || (resolved.temp_c == null && departmentRequiresTemp(dept.id))) {
        const err = new Error(resolved.reason || 'Invalid temperature.');
        err.status = 400;
        throw err;
    }

    const spot1 = resolved.spots[0] ?? null;
    const spot2 = resolved.spots.length >= 3 ? resolved.spots[1] : null;
    const spot3 = resolved.spots.length >= 3 ? resolved.spots[2] : null;
    const noteText = notes !== undefined
        ? String(notes || '').trim().slice(0, 200)
        : String(existing.notes || '').trim().slice(0, 200);
    const ts = new Date().toISOString();

    try {
        db.run(`
            UPDATE receiving_pallets SET
                license_plate = ?, department = ?,
                temp_c = ?, temp_spot_1 = ?, temp_spot_2 = ?, temp_spot_3 = ?,
                in_range = ?, notes = ?, captured_at = ?, captured_by = ?
            WHERE pallet_id = ?
        `,
        plate,
        dept.id,
        resolved.temp_c,
        spot1,
        spot2,
        spot3,
        resolved.in_range ? 1 : 0,
        noteText,
        ts,
        actorName || existing.captured_by || '',
        palletId);
    } catch (e) {
        if (!String(e.message || e).includes('no such column')) throw e;
        db.run(`
            UPDATE receiving_pallets SET
                license_plate = ?, department = ?,
                temp_c = ?, in_range = ?, notes = ?, captured_at = ?, captured_by = ?
            WHERE pallet_id = ?
        `,
        plate,
        dept.id,
        resolved.temp_c,
        resolved.in_range ? 1 : 0,
        noteText,
        ts,
        actorName || existing.captured_by || '',
        palletId);
    }

    return {
        pallet_id: palletId,
        exp_id: existing.exp_id,
        store_date: existing.store_date,
        seq_num: existing.seq_num,
        license_plate: plate,
        department: dept.id,
        department_label: dept.label,
        temp_c: resolved.temp_c,
        temp_spot_1: spot1,
        temp_spot_2: spot2,
        temp_spot_3: spot3,
        spot_checks: formatSpotChecks({
            temp_c: resolved.temp_c,
            temp_spot_1: spot1,
            temp_spot_2: spot2,
            temp_spot_3: spot3,
        }),
        in_range: resolved.in_range,
        notes: noteText,
        captured_at: ts,
        captured_by: actorName || existing.captured_by || '',
    };
}

function listReceivingDayLog(db, storeDate, options = {}) {
    const date = String(storeDate || '').trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        const err = new Error('Expected date in YYYY-MM-DD format.');
        err.status = 400;
        throw err;
    }

    // Timestamps are UTC ISO; the date picker is store-local. Match both UTC
    // substr (legacy) and store-local date() so evening trucks still appear.
    let tzMod = '';
    try {
        const { getStoreMeta } = require('../constants/store-meta.cjs');
        const { normalizeStoreTimezone } = require('./store-timezone.cjs');
        const { sqliteTzOffsetModifier } = require('./store-time.cjs');
        const settings = typeof db.getSettings === 'function'
            ? db.getSettings()
            : Object.fromEntries(
                (db.all('SELECT setting_name, setting_value FROM settings') || [])
                    .map((r) => [r.setting_name, r.setting_value]),
            );
        const tz = normalizeStoreTimezone(getStoreMeta(settings).timezone).timezone;
        tzMod = sqliteTzOffsetModifier(tz, new Date(`${date}T12:00:00Z`));
        if (!/^[+-]\d+ minutes$/.test(tzMod) || tzMod === '+0 minutes') tzMod = '';
    } catch (_) {
        tzMod = '';
    }

    const localArrived = tzMod ? `date(arrived_at, '${tzMod}')=?` : '0';
    const localDeparted = tzMod ? `date(departed_at, '${tzMod}')=?` : '0';
    const localClosed = tzMod ? `date(time_closed, '${tzMod}')=?` : '0';
    const params = tzMod
        ? [date, date, date, date, date, date, date]
        : [date, date, date, date];

    const rows = db.all(
        `SELECT exp_id, vendor, expected_day, status, category, arrived_at, arrived_by,
                departed_at, departed_by, closed_by, time_closed, invoice_ref, pieces
           FROM expected_orders
          WHERE category!='hardware'
            AND arrived=1
            AND (
                 substr(COALESCE(arrived_at,''),1,10)=?
              OR substr(COALESCE(departed_at,''),1,10)=?
              OR substr(COALESCE(time_closed,''),1,10)=?
              OR expected_day=?
              OR ${localArrived}
              OR ${localDeparted}
              OR ${localClosed}
            )
          ORDER BY COALESCE(arrived_at, departed_at, time_closed, exp_id) ASC
          LIMIT 120`,
        ...params,
    ) || [];
    return attachPalletsToDockRows(db, rows);
}

function assertTgpPalletIntakeComplete(db, order) {
    if (!isTgpVendor(order?.vendor)) return;
    const count = countPalletsForExp(db, order.exp_id);
    if (count < 1) {
        const err = new Error('Log at least one TGP pallet (license plate, department, temp) before time out.');
        err.status = 400;
        throw err;
    }
}

function storageConfirmed(workingData) {
    const v = workingData?.storage_confirmed ?? workingData?.stored_properly;
    if (v === false || v === 0 || v === '0' || v === 'no' || v === 'false') return false;
    return v === true || v === 1 || v === '1' || v === 'yes' || v === 'true';
}

function listColdChainForReport(db, reportStart, reportEnd) {
    try {
        return db.all(`
            SELECT p.pallet_id, p.exp_id, p.store_date, p.seq_num, p.license_plate, p.department,
                   p.temp_c, p.temp_spot_1, p.temp_spot_2, p.temp_spot_3, p.in_range, p.notes,
                   p.captured_at, p.captured_by,
                   o.vendor, o.invoice_ref, o.arrived_at, o.departed_at
            FROM receiving_pallets p
            JOIN expected_orders o ON o.exp_id = p.exp_id
            WHERE p.store_date BETWEEN ? AND ?
            ORDER BY p.store_date DESC, datetime(COALESCE(o.arrived_at, p.captured_at)) DESC, p.seq_num ASC
        `, reportStart, reportEnd) || [];
    } catch (_) {
        try {
            return db.all(`
                SELECT p.pallet_id, p.exp_id, p.store_date, p.seq_num, p.license_plate, p.department,
                       p.temp_c, p.in_range, p.notes, p.captured_at, p.captured_by,
                       o.vendor, o.invoice_ref, o.arrived_at, o.departed_at
                FROM receiving_pallets p
                JOIN expected_orders o ON o.exp_id = p.exp_id
                WHERE p.store_date BETWEEN ? AND ?
                ORDER BY p.store_date DESC, datetime(COALESCE(o.arrived_at, p.captured_at)) DESC, p.seq_num ASC
            `, reportStart, reportEnd) || [];
        } catch (__) {
            return [];
        }
    }
}

function formatDepartmentDisplay(departmentId) {
    const id = String(departmentId || '').trim();
    const meta = departmentMeta(id);
    if (!id) return '';
    return meta ? `${id} · ${meta.label}` : id;
}

function enrichColdChainRows(rows) {
    return (rows || []).map((row) => ({
        ...row,
        department_label: departmentMeta(row.department)?.label || row.department || '',
        department_display: formatDepartmentDisplay(row.department),
        spot_checks: formatSpotChecks(row),
    }));
}

function attachPalletsToDockRows(db, rows) {
    return (rows || []).map((row) => ({
        ...row,
        pallets: isTgpVendor(row.vendor) ? listPalletsForExp(db, row.exp_id) : [],
        pallet_count: isTgpVendor(row.vendor) ? countPalletsForExp(db, row.exp_id) : 0,
        is_tgp: isTgpVendor(row.vendor),
    }));
}

module.exports = {
    TGP_STORAGE_CONFIRM_PROMPT,
    PALLET_DEPARTMENTS,
    departmentMeta,
    departmentRequiresTemp,
    evaluatePalletTemp,
    resolvePalletTemperature,
    formatSpotChecks,
    formatLicensePlatesInput,
    listPalletsForExp,
    countPalletsForExp,
    addReceivingPallet,
    updateReceivingPallet,
    deleteReceivingPallet,
    listReceivingDayLog,
    assertTgpPalletIntakeComplete,
    storageConfirmed,
    listColdChainForReport,
    enrichColdChainRows,
    formatDepartmentDisplay,
    attachPalletsToDockRows,
};
