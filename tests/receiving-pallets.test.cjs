'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    evaluatePalletTemp,
    resolvePalletTemperature,
    departmentMeta,
    PALLET_DEPARTMENTS,
    enrichColdChainRows,
    formatDepartmentDisplay,
    formatLicensePlatesInput,
    formatSpotChecks,
    updateReceivingPallet,
    addReceivingPallet,
    listReceivingDayLog,
} = require('../src/lib/receiving-pallets.cjs');

test('evaluatePalletTemp accepts refrigerated 1-4 C', () => {
    const result = evaluatePalletTemp('produce', 3);
    assert.equal(result.valid, true);
    assert.equal(result.in_range, true);
});

test('evaluatePalletTemp flags refrigerated out of range', () => {
    const result = evaluatePalletTemp('dairy', 8);
    assert.equal(result.valid, true);
    assert.equal(result.in_range, false);
});

test('evaluatePalletTemp accepts frozen at -18 C or below', () => {
    assert.equal(evaluatePalletTemp('frozen', -18).in_range, true);
    assert.equal(evaluatePalletTemp('frozen', -20).in_range, true);
    assert.equal(evaluatePalletTemp('frozen', -10).in_range, false);
});

test('dry grocery does not require temperature', () => {
    assert.equal(departmentMeta('dry_grocery')?.storage, 'ambient');
    assert.equal(departmentMeta('dry_grocery')?.requires_temp, false);
    assert.equal(departmentMeta('grocery')?.label, 'Perishables');
    const noTemp = resolvePalletTemperature('dry_grocery', null, []);
    assert.equal(noTemp.valid, true);
    assert.equal(noTemp.temp_c, null);
    assert.equal(noTemp.in_range, true);
    assert.equal(evaluatePalletTemp('dry_grocery', 12).in_range, true);
    assert.equal(evaluatePalletTemp('dry_grocery', 0.1).in_range, true);
    assert.equal(evaluatePalletTemp('dry_grocery', 0).in_range, false);
    assert.equal(evaluatePalletTemp('dry_grocery', -1).in_range, false);
});

test('produce_ambient matches dry grocery ambient rules', () => {
    assert.equal(departmentMeta('produce_ambient')?.storage, 'ambient');
    assert.equal(departmentMeta('produce_ambient')?.requires_temp, false);
    assert.equal(departmentMeta('produce_ambient')?.label, 'Produce (Ambient)');
    const noTemp = resolvePalletTemperature('produce_ambient', null, []);
    assert.equal(noTemp.valid, true);
    assert.equal(noTemp.in_range, true);
    assert.equal(evaluatePalletTemp('produce_ambient', 18).in_range, true);
    assert.equal(evaluatePalletTemp('produce_ambient', 0).in_range, false);
    assert.equal(resolvePalletTemperature('produce_ambient', 15).needs_more_spots, false);
});

test('PALLET_DEPARTMENTS includes dry grocery and perishables', () => {
    assert.ok(PALLET_DEPARTMENTS.some((d) => d.id === 'produce'));
    assert.ok(PALLET_DEPARTMENTS.some((d) => d.id === 'produce_ambient'));
    assert.ok(PALLET_DEPARTMENTS.some((d) => d.id === 'grocery'));
    assert.ok(PALLET_DEPARTMENTS.some((d) => d.id === 'dry_grocery'));
    assert.ok(PALLET_DEPARTMENTS.some((d) => d.id === 'frozen'));
    assert.equal(departmentMeta('frozen')?.storage, 'frozen');
    assert.equal(departmentMeta('grocery')?.storage, 'refrigerated');
    assert.equal(departmentMeta('grocery')?.label, 'Perishables');
});

test('resolvePalletTemperature asks for more spots when chilled OOR with one reading', () => {
    const r = resolvePalletTemperature('produce', 8);
    assert.equal(r.needs_more_spots, true);
    assert.equal(r.valid, false);
});

test('resolvePalletTemperature averages three OOR chilled spots', () => {
    const r = resolvePalletTemperature('dairy', null, [8, 2, 3]);
    assert.equal(r.needs_more_spots, false);
    assert.equal(r.valid, true);
    assert.equal(r.temp_c, 4.3);
    assert.equal(r.in_range, false); // avg 4.3 still outside 1-4
    assert.deepEqual(r.spots, [8, 2, 3]);
});

test('resolvePalletTemperature three spots can bring average into range', () => {
    const r = resolvePalletTemperature('produce', null, [6, 2, 3]);
    assert.equal(r.temp_c, 3.7);
    assert.equal(r.in_range, true);
});

test('resolvePalletTemperature dry grocery never asks for multi-spot', () => {
    const r = resolvePalletTemperature('dry_grocery', 18);
    assert.equal(r.needs_more_spots, false);
    assert.equal(r.in_range, true);
    assert.equal(r.spots.length, 1);
    const blank = resolvePalletTemperature('dry_grocery', null, []);
    assert.equal(blank.valid, true);
    assert.equal(blank.temp_c, null);
});

test('formatLicensePlatesInput splits concatenated scans on letter boundaries', () => {
    assert.equal(formatLicensePlatesInput('p12345p67890'), 'P12345 P67890');
    assert.equal(formatLicensePlatesInput('P12345 P67890'), 'P12345 P67890');
    assert.equal(formatLicensePlatesInput('a1b2c3'), 'A1 B2 C3');
});

test('enrichColdChainRows adds department id and spot checks', () => {
    const rows = enrichColdChainRows([{
        department: 'produce',
        temp_c: 4.3,
        temp_spot_1: 8,
        temp_spot_2: 2,
        temp_spot_3: 3,
        in_range: 0,
    }]);
    assert.equal(rows[0].department, 'produce');
    assert.equal(rows[0].department_label, 'Produce');
    assert.equal(formatDepartmentDisplay('produce'), 'produce · Produce');
    assert.equal(formatSpotChecks(rows[0]), '8 / 2 / 3 → avg 4.3');
    assert.match(rows[0].spot_checks, /8 \/ 2 \/ 3 → avg 4\.3/);
});

test('updateReceivingPallet can reclassify OOR produce to produce_ambient after time out', () => {
    const row = {
        pallet_id: 'PLT-1',
        exp_id: 'E-1',
        store_date: '2026-07-28',
        seq_num: 1,
        license_plate: 'P12345',
        department: 'produce',
        temp_c: 18,
        temp_spot_1: 18,
        temp_spot_2: null,
        temp_spot_3: null,
        in_range: 0,
        notes: '',
        captured_at: '2026-07-28T12:00:00.000Z',
        captured_by: 'Ashley',
    };
    const db = {
        get(sql) {
            if (sql.includes('FROM receiving_pallets')) return row;
            return null;
        },
        run(sql, ...params) {
            if (sql.includes('UPDATE receiving_pallets')) {
                row.license_plate = params[0];
                row.department = params[1];
                row.temp_c = params[2];
                row.temp_spot_1 = params[3];
                row.temp_spot_2 = params[4];
                row.temp_spot_3 = params[5];
                row.in_range = params[6];
                row.notes = params[7];
                row.captured_at = params[8];
                row.captured_by = params[9];
            }
        },
    };

    const updated = updateReceivingPallet(db, {
        palletId: 'PLT-1',
        department: 'produce_ambient',
        licensePlate: 'P12345',
        tempC: 18,
        actorName: 'Manager',
    });
    assert.equal(updated.department, 'produce_ambient');
    assert.equal(updated.in_range, true);
    assert.equal(row.in_range, 1);
    assert.equal(row.department, 'produce_ambient');
});

test('listReceivingDayLog rejects bad dates and attaches pallets for TGP', () => {
    assert.throws(() => listReceivingDayLog({ all() { return []; } }, 'nope'), /YYYY-MM-DD/);
    const orders = [{
        exp_id: 'E-TGP',
        vendor: 'TGP Edmonton',
        arrived: 1,
        arrived_at: '2026-07-28T12:00:00.000Z',
        departed_at: '2026-07-28T14:00:00.000Z',
        status: 'Closed',
    }];
    const pallets = [{
        pallet_id: 'PLT-9',
        exp_id: 'E-TGP',
        license_plate: 'P9',
        department: 'produce_ambient',
        temp_c: 16,
        in_range: 1,
    }];
    const db = {
        all(sql) {
            if (sql.includes('FROM expected_orders')) return orders;
            if (sql.includes('FROM receiving_pallets')) return pallets;
            return [];
        },
        get(sql) {
            if (sql.includes('COUNT(*)')) return { c: pallets.length };
            return null;
        },
    };
    const rows = listReceivingDayLog(db, '2026-07-28');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].is_tgp, true);
    assert.equal(rows[0].pallet_count, 1);
    assert.equal(rows[0].pallets[0].license_plate, 'P9');
});

test('listReceivingDayLog SQL matches store-local evening arrivals (UTC next day)', () => {
    let capturedSql = '';
    let capturedParams = [];
    const db = {
        getSettings() {
            return { Store_Timezone: 'America/Edmonton' };
        },
        all(sql, ...params) {
            if (sql.includes('FROM expected_orders')) {
                capturedSql = sql;
                capturedParams = params;
                return [];
            }
            return [];
        },
        get() { return null; },
    };
    listReceivingDayLog(db, '2026-07-27');
    assert.match(capturedSql, /date\(arrived_at,/);
    assert.ok(capturedParams.length >= 7, 'expected local-date bind params');
    assert.ok(capturedParams.every((p) => p === '2026-07-27'));
});

test('addReceivingPallet allows post time-out when allowAfterDeparted', () => {
    const inserts = [];
    const db = {
        get(sql) {
            if (sql.includes('FROM expected_orders')) {
                return { exp_id: 'E1', vendor: 'TGP Edmonton', arrived: 1, departed_at: '2026-07-27T20:00:00.000Z' };
            }
            if (sql.includes('MAX(seq_num)')) return { m: 0 };
            return null;
        },
        run(...args) { inserts.push(args); },
    };
    assert.throws(() => addReceivingPallet(db, {
        expId: 'E1',
        storeDate: '2026-07-27',
        licensePlate: '1A2B3',
        department: 'dry_grocery',
        actorName: 'Test',
    }), /on dock/);
    const pallet = addReceivingPallet(db, {
        expId: 'E1',
        storeDate: '2026-07-27',
        licensePlate: '1A2B3',
        department: 'dry_grocery',
        actorName: 'Test',
        allowAfterDeparted: true,
    });
    assert.equal(pallet.store_date, '2026-07-27');
    assert.equal(pallet.department, 'dry_grocery');
    assert.ok(inserts.length >= 1);
});
