'use strict';

/**
 * Shift Roster role assignment.
 *
 * Bug this pins: a manager set Sam to "Customer Service" and the save persisted, but the roster
 * kept showing him under Cash. The client had its own drifted copy of the bucket rules where
 * /cash/ (no word boundary) matched the job title "…Clerk/Cashier" and was checked before
 * Customer Service, so the department could never win. Same class of bug put Ashley (dept REC,
 * title "Premium Centre Store Clerk") under Premium instead of Receiving.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { classifyShift } = require('../src/lib/schedule-role-buckets.cjs');
const { extractShiftsFromUpload } = require('../src/lib/staff-schedule-import.cjs');
const { seedStaffNameAliases, isStaffAliasExcludedFromImport } = require('../src/lib/staff-name-aliases.cjs');

const appRoot = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(appRoot, rel), 'utf8');

/** Real rows from the store schedule on 2026-07-31. */
const LIVE_ROWS = [
    { who: 'Sam (after manager override)', dept: 'Customer Service', role: 'FT Centre Store Clerk/Cashier', bucket: 'cs' },
    { who: 'Sam (as imported)', dept: 'CUST SERV', role: 'FT Centre Store Clerk/Cashier', bucket: 'cs' },
    { who: 'Ashley', dept: 'REC', role: 'Premium Centre Store Clerk (3)', bucket: 'rec' },
    { who: 'Chandler', dept: 'CLOSER', role: 'Premium Centre Store Clerk (4)', bucket: 'premium' },
    { who: 'Chris', dept: '', role: 'Centre Store Supervisor', bucket: 'supervisor' },
    { who: 'Gabi', dept: 'OPEN CASH', role: 'PT Centre Store Clerk/Cashier', bucket: 'cash' },
    { who: 'Izzy', dept: 'BAKERY', role: 'PT Centre Store Clerk/Cashier', bucket: 'bakery' },
    { who: 'Nora', dept: 'STOCK/FLOAT', role: 'PT Centre Store Clerk/Cashier', bucket: 'stock_float' },
    { who: 'Oxana', dept: 'CLO CASH', role: 'FT Centre Store Clerk/Cashier', bucket: 'cash' },
    { who: 'Shannon', dept: '8', role: 'Scanning/Office Coordinator', bucket: 'other' },
];

test('live schedule rows bucket correctly (Sam is CS, Ashley is REC)', () => {
    LIVE_ROWS.forEach(({ who, dept, role, bucket }) => {
        assert.equal(classifyShift(dept, role), bucket, `${who}: dept=${dept} role=${role}`);
    });
});

test('a Cashier job title cannot out-vote the department a manager picked', () => {
    const cashierTitle = 'FT Centre Store Clerk/Cashier';
    const expected = {
        'Stock/Float': 'stock_float',
        REC: 'rec',
        Supervisor: 'supervisor',
        Premium: 'premium',
        'Open Cash': 'cash',
        'Customer Service': 'cs',
        Bakery: 'bakery',
        Grocery: 'stock_float',
        Freezer: 'stock_float',
        Other: 'other',
    };
    Object.entries(expected).forEach(([deptOption, bucket]) => {
        assert.equal(classifyShift(deptOption, cashierTitle), bucket, `dropdown value ${deptOption}`);
    });
});

test('role text is still used when the department says nothing useful', () => {
    assert.equal(classifyShift('', 'Centre Store Supervisor'), 'supervisor');
    assert.equal(classifyShift('CLOSER', 'Premium Clerk'), 'premium');
    assert.equal(classifyShift('OUTSIDE', 'PT Clerk'), 'other');
    assert.equal(classifyShift('', ''), 'other');
});

test('client classifier mirrors the server rules exactly', async () => {
    const client = await import(
        `file://${path.join(appRoot, 'client/src/lib/floorUtils.js').replace(/\\/g, '/')}`
    );
    const cases = [
        ...LIVE_ROWS.map((r) => [r.dept, r.role]),
        ['Customer Service', 'Cashier'],
        ['CUST SERV', 'Cashier'],
        ['REC', 'Premium Clerk'],
        ['Open Cash', 'Clerk'],
        ['Freezer', 'Clerk'],
        ['Grocery', 'Clerk'],
        ['Supervisor', 'Clerk'],
        ['', 'Store Manager'],
        ['', 'Manager'],
        ['8', 'Scanning/Office Coordinator'],
        ['', ''],
    ];
    cases.forEach(([dept, role]) => {
        assert.equal(
            client.classifyImportedShift(dept, role),
            classifyShift(dept, role),
            `client/server disagree on dept=${JSON.stringify(dept)} role=${JSON.stringify(role)}`,
        );
    });
});

test('client prefers the bucket the server sent over guessing locally', async () => {
    const client = await import(
        `file://${path.join(appRoot, 'client/src/lib/floorUtils.js').replace(/\\/g, '/')}`
    );
    const shift = { department: 'Customer Service', role: 'FT Centre Store Clerk/Cashier', bucket: 'cs' };
    assert.equal(client.scheduleBucketForShift(shift), 'cs');
    assert.equal(client.scheduleDeptValueForShift(shift), 'Customer Service');

    // Missing/garbage bucket falls back to the local mirror rather than rendering an empty group.
    assert.equal(client.scheduleBucketForShift({ ...shift, bucket: '' }), 'cs');
    assert.equal(client.scheduleBucketForShift({ ...shift, bucket: 'nonsense' }), 'cs');

    // Freezer/Grocery refinement must read department only, never the job title.
    assert.equal(client.scheduleDeptValueForShift({ department: 'Freezer', role: 'Clerk', bucket: 'stock_float' }), 'Freezer');
    assert.equal(client.scheduleDeptValueForShift({ department: 'STOCK/FLOAT', role: 'Frozen Food Clerk', bucket: 'stock_float' }), 'Stock/Float');
});

test('sync sends a server-computed bucket and the UI consumes it', () => {
    const sync = read('src/dal/sync-payload.cjs');
    assert.match(sync, /classifyShift/, 'sync payload should classify shift rows');
    assert.match(sync, /bucket: classifyShift\(s\.department, s\.role/, 'each staff_shifts row needs a bucket');

    const panel = read('client/src/components/floor/sidebar/ShiftRosterPanel.jsx');
    assert.match(panel, /scheduleBucketForShift\(shift\)/);
    assert.match(panel, /scheduleDeptValueForShift\(s\)/);
    assert.ok(!/classifyImportedShift/.test(panel), 'roster must not classify locally');

    // Settings must re-export the one classifier, not keep a second copy.
    const helpers = read('client/src/settings/lib/settingsHelpers.js');
    assert.match(helpers, /export \{[\s\S]*classifyImportedShift[\s\S]*\} from '\.\.\/\.\.\/lib\/floorUtils\.js'/);
    assert.ok(!/function classifyImportedShift/.test(helpers), 'no duplicate classifier in settings');
});

test('saving a schedule role keeps the imported job title', () => {
    const actions = read('client/src/lib/floorActions.js');
    assert.ok(!/staff-shifts\/update'[^)]*role: ''/.test(actions), 'floor save must not blank the role');
    const api = read('client/src/settings/lib/settingsApi.js');
    assert.ok(!/staff-shifts\/update'[^)]*role: ''/.test(api), 'settings save must not blank the role');

    // An explicit empty role still clears it; an omitted role leaves the stored value alone.
    const ops = read('src/routes/manager/ops.cjs');
    assert.match(ops, /roleProvided = req\.body\?\.role !== undefined/);
    assert.match(ops, /nextRole = roleProvided \? role : \(row\.role \|\| ''\)/);
});

function makeAliasDb() {
    const rows = new Map();
    return {
        exec() {},
        get(sql, ...params) {
            if (sql.includes('created_at FROM staff_name_aliases')) return rows.get(params[0]) || null;
            return null;
        },
        run(sql, ...params) {
            if (sql.includes('INSERT INTO staff_name_aliases')) {
                const [sourceName, sourceKey, targetName, aliasType, notes, createdAt, updatedAt] = params;
                rows.set(sourceName, {
                    source_name: sourceName,
                    source_key: sourceKey,
                    target_name: targetName,
                    alias_type: aliasType,
                    active: 1,
                    notes,
                    created_at: createdAt,
                    updated_at: updatedAt,
                });
            }
            return { changes: 1 };
        },
        all(sql) {
            if (sql.includes('staff_name_aliases')) {
                return [...rows.values()].filter((r) => r.active !== 0);
            }
            return [];
        },
    };
}

const SCHEDULE_CSV = [
    'Name,Date,Start,End,Role,Department',
    'Shannon,2026-07-31,07:00,15:30,Scanning/Office Coordinator,8',
    'Shanelle,2026-07-31,08:00,16:00,Clerk,STOCK/FLOAT',
    'Connor,2026-07-31,09:00,17:00,Clerk,STOCK/FLOAT',
    'Isabella,2026-07-31,07:00,15:30,PT Centre Store Clerk/Cashier,BAKERY',
    'Sam,2026-07-31,07:45,16:15,FT Centre Store Clerk/Cashier,CUST SERV',
    '',
].join('\n');

test('CSV import skips file-maintenance and departed names', async () => {
    const db = makeAliasDb();
    seedStaffNameAliases(db);

    const result = await extractShiftsFromUpload(
        db,
        'week.csv',
        Buffer.from(SCHEDULE_CSV, 'utf8').toString('base64'),
        'Chris',
    );

    const names = result.shifts.map((s) => s.staff_name).sort();
    assert.deepEqual(names, ['Connor', 'Izzy', 'Sam'], 'Shannon and Shanelle must not be stored');

    const skipped = (result.skipped || []).map((s) => `${s.staff_name}:${s.reason}`).sort();
    assert.deepEqual(skipped, ['Shanelle:inactive', 'Shannon:file_maintenance']);
});

test('pending staff still import — only non-floor names are dropped', () => {
    assert.equal(isStaffAliasExcludedFromImport({ alias_type: 'file_maintenance', active: true }), true);
    assert.equal(isStaffAliasExcludedFromImport({ alias_type: 'inactive', active: true }), true);
    assert.equal(isStaffAliasExcludedFromImport({ alias_type: 'pending_staff', active: true }), false);
    assert.equal(isStaffAliasExcludedFromImport({ alias_type: 'schedule_only', active: true }), false);
    assert.equal(isStaffAliasExcludedFromImport({ alias_type: 'alias', active: true }), false);
    assert.equal(isStaffAliasExcludedFromImport({ alias_type: 'inactive', active: false }), false);
    assert.equal(isStaffAliasExcludedFromImport(null), false);
});

test('import clears rows a previous import left for skipped names', () => {
    const ops = read('src/routes/manager/ops.cjs');
    assert.match(ops, /DELETE FROM staff_shifts WHERE staff_name = \?/);
    assert.match(ops, /skipped: extracted\.skipped \|\| \[\]/);
});
