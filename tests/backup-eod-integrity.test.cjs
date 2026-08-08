'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const fs = require('fs');
const path = require('path');
const { runMigrations, listMigrationFiles } = require('../src/migrations/runner.cjs');
const registerApi = require('../src/api.cjs');
const { catchUpMissedSweeps } = require('../src/lib/app-boot.cjs');

const EOD_BACKUP_SETTINGS = [
    'Eod_Last_Pre_Backup_Package',
    'Eod_Last_Post_Backup_Package',
    'Eod_Last_Backup_Error',
    'Eod_Last_Backup_Ok_At',
];

const STORE_DATE = '2026-08-04';

function requireSqlite(t) {
    try {
        const Database = require('better-sqlite3');
        const probe = new Database(':memory:');
        probe.close();
        return Database;
    } catch (error) {
        const message = String(error?.message || error);
        if (message.includes('NODE_MODULE_VERSION') || message.includes('Could not locate the bindings file')) {
            t.skip(`better-sqlite3 is not loadable in this runtime: ${message}`);
            return null;
        }
        throw error;
    }
}

function wrap(sqlite) {
    return {
        all: (sql, ...params) => sqlite.prepare(sql).all(...params),
        get: (sql, ...params) => sqlite.prepare(sql).get(...params),
        run: (sql, ...params) => sqlite.prepare(sql).run(...params),
        exec: (sql) => sqlite.exec(sql),
        transaction: (fn) => sqlite.transaction(fn),
        getSettings: () => sqlite.prepare('SELECT * FROM settings').all()
            .reduce((acc, s) => ({ ...acc, [s.setting_name]: s.setting_value }), {}),
    };
}

function makeServer() {
    const server = { use() {} };
    for (const method of ['get', 'post', 'put', 'patch', 'delete']) {
        server[method] = () => {};
    }
    return server;
}

function createEodHarness(t) {
    const Database = requireSqlite(t);
    if (!Database) return null;
    const sqlite = new Database(':memory:');
    const db = wrap(sqlite);
    db.exec(`
        CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);
        CREATE TABLE tasks (
            task_id TEXT PRIMARY KEY, task_detail TEXT, status TEXT, priority TEXT,
            zone TEXT, assigned_to TEXT, est_mins INTEGER, time_submitted TEXT,
            time_closed TEXT, closed_by TEXT
        );
        CREATE TABLE oos (
            id TEXT PRIMARY KEY, item TEXT, status TEXT, time_logged TEXT,
            time_closed TEXT, closed_by TEXT
        );
        CREATE TABLE special_orders (
            order_id TEXT PRIMARY KEY, status TEXT, time_logged TEXT,
            time_closed TEXT, closed_by TEXT
        );
        CREATE TABLE expected_orders (
            exp_id TEXT PRIMARY KEY, status TEXT, category TEXT,
            time_closed TEXT, closed_by TEXT
        );
        CREATE TABLE kill_dates (
            id TEXT PRIMARY KEY, status TEXT, time_closed TEXT, closed_by TEXT
        );
        CREATE TABLE shrink_log (
            id TEXT PRIMARY KEY, status TEXT, time_logged TEXT
        );
        CREATE TABLE homebase_audits (
            id INTEGER PRIMARY KEY, zone_name TEXT, timestamp TEXT, audit_data TEXT
        );
        CREATE TABLE ticker (id TEXT PRIMARY KEY, message TEXT);
        CREATE TABLE audit_ledger (
            id TEXT PRIMARY KEY, timestamp TEXT, user TEXT,
            action_type TEXT, target_table TEXT, details TEXT
        );
        CREATE TABLE counts (id INTEGER PRIMARY KEY, hardware INTEGER DEFAULT 0);
    `);
    for (const name of EOD_BACKUP_SETTINGS) {
        db.run('INSERT INTO settings (setting_name, setting_value) VALUES (?, ?)', name, '');
    }
    db.run(
        `INSERT INTO tasks (task_id, task_detail, status, priority, time_submitted)
         VALUES ('T-OPEN-1', 'Face dairy', 'Open', 'Routine', '2026-08-03T15:00:00.000Z')`,
    );

    const api = registerApi(
        makeServer(),
        db,
        { getSession: () => null },
        () => {},
        () => STORE_DATE,
        () => 'Tuesday',
        () => ({ storeTimezone: 'America/Edmonton' }),
    );
    t.after(() => sqlite.close());

    return {
        db,
        sqlite,
        today: STORE_DATE,
        executeEODSweep: api.executeEODSweep,
        getSetting(name) {
            return db.get(
                'SELECT setting_value FROM settings WHERE setting_name = ?',
                name,
            )?.setting_value ?? null;
        },
        countOpenTasks() {
            return Number(
                db.get("SELECT COUNT(*) AS c FROM tasks WHERE status='Open'")?.c || 0,
            );
        },
        okPackage(stage, packageId) {
            return {
                ok: true,
                packageId: packageId || `pkg_${stage}_${STORE_DATE}`,
                directory: null,
                opsDbPath: null,
                manifest: null,
                labelDate: STORE_DATE,
                error: null,
                code: null,
            };
        },
        failPackage(stage, message = `${stage} backup failed`) {
            return {
                ok: false,
                packageId: null,
                directory: null,
                opsDbPath: null,
                manifest: null,
                labelDate: STORE_DATE,
                error: message,
                code: 'BACKUP_VERIFICATION_FAILED',
            };
        },
    };
}

function createUpgradeFixture(t) {
    const Database = requireSqlite(t);
    if (!Database) return null;
    const sqlite = new Database(':memory:');
    const db = wrap(sqlite);
    db.exec(`
        CREATE TABLE schema_version (
            version INTEGER PRIMARY KEY,
            applied_at TEXT NOT NULL,
            name TEXT NOT NULL
        );
        CREATE TABLE settings (
            setting_name TEXT PRIMARY KEY,
            setting_value TEXT
        );
    `);
    for (let version = 1; version <= 60; version += 1) {
        db.run(
            'INSERT INTO schema_version (version, applied_at, name) VALUES (?, ?, ?)',
            version,
            '2026-08-04T00:00:00.000Z',
            `fixture_${version}`,
        );
    }
    return { sqlite, db };
}

function assertEodBackupSettings(db, expectedValue = '') {
    for (const settingName of EOD_BACKUP_SETTINGS) {
        const row = db.get(
            'SELECT setting_value FROM settings WHERE setting_name = ?',
            settingName,
        );
        assert.ok(row, `setting ${settingName} must exist after migration 061`);
        assert.equal(row.setting_value, expectedValue, `${settingName} default value`);
    }
}

test('migration 061 seeds durable EOD backup status settings', (t) => {
    const fixture = createUpgradeFixture(t);
    if (!fixture) return;
    const { sqlite, db } = fixture;

    runMigrations(db);

    assertEodBackupSettings(db);
    assert.equal(
        db.get('SELECT name FROM schema_version WHERE version = 61').name,
        'backup_integrity_controls',
    );

    sqlite.close();
});

test('migration 061 up body is directly idempotent', (t) => {
    const fixture = createUpgradeFixture(t);
    if (!fixture) return;
    const { sqlite, db } = fixture;
    assert.ok(
        listMigrationFiles().includes('061_backup_integrity_controls.cjs'),
        'migration 061 must exist',
    );
    const migration = require('../src/migrations/061_backup_integrity_controls.cjs');

    migration.up(db);
    assertEodBackupSettings(db);

    db.run(
        "UPDATE settings SET setting_value = 'existing' WHERE setting_name = 'Eod_Last_Backup_Error'",
    );
    migration.up(db);

    assert.equal(
        db.get("SELECT setting_value FROM settings WHERE setting_name = 'Eod_Last_Backup_Error'").setting_value,
        'existing',
        'idempotent upsert must not overwrite existing values',
    );
    for (const settingName of EOD_BACKUP_SETTINGS) {
        if (settingName === 'Eod_Last_Backup_Error') continue;
        assert.equal(
            db.get('SELECT setting_value FROM settings WHERE setting_name = ?', settingName).setting_value,
            '',
        );
    }

    sqlite.close();
});

test('migration runner rolls back migration 061 on schema_version failure', (t) => {
    const fixture = createUpgradeFixture(t);
    if (!fixture) return;
    const { sqlite, db } = fixture;
    const run = db.run;
    db.run = (sql, ...params) => {
        if (sql.includes('INSERT INTO schema_version') && params[0] === 61) {
            throw new Error('injected schema-version failure');
        }
        return run(sql, ...params);
    };

    assert.throws(() => runMigrations(db), /injected schema-version failure/);

    for (const settingName of EOD_BACKUP_SETTINGS) {
        assert.equal(
            db.get('SELECT setting_value FROM settings WHERE setting_name = ?', settingName),
            undefined,
            `${settingName} must not persist when schema_version insert fails`,
        );
    }
    assert.equal(db.get('SELECT COUNT(*) AS count FROM schema_version WHERE version = 61').count, 0);

    sqlite.close();
});

test('EOD aborts before purge when pre-backup fails', async (t) => {
    const harness = createEodHarness(t);
    if (!harness) return;

    await assert.rejects(
        () => harness.executeEODSweep(new Date('2026-08-04T18:00:00.000Z'), {
            skipOrderHistoryArchive: true,
            createBackupPackage: async ({ stage }) => {
                assert.equal(stage, 'pre_eod');
                return harness.failPackage('pre_eod', 'disk full');
            },
            getDataRoot: () => 'C:\\fake-data-root',
        }),
        (err) => {
            assert.equal(err.code, 'EOD_PRE_BACKUP_REQUIRED');
            assert.equal(err.status, 500);
            assert.match(String(err.message), /pre/i);
            return true;
        },
    );

    assert.notEqual(harness.getSetting('Last_EOD_Sweep'), harness.today);
    assert.equal(harness.countOpenTasks(), 1, 'open tasks must remain when pre-backup fails');
    assert.match(String(harness.getSetting('Eod_Last_Backup_Error') || ''), /disk full|pre/i);
});

test('post-backup failure does not return EOD success', async (t) => {
    const harness = createEodHarness(t);
    if (!harness) return;

    let stages = [];
    await assert.rejects(
        () => harness.executeEODSweep(new Date('2026-08-04T18:00:00.000Z'), {
            skipOrderHistoryArchive: true,
            createBackupPackage: async ({ stage }) => {
                stages.push(stage);
                if (stage === 'pre_eod') return harness.okPackage('pre_eod', 'pkg_pre_1');
                return harness.failPackage('post_eod', 'post verification failed');
            },
            getDataRoot: () => 'C:\\fake-data-root',
        }),
        (err) => {
            assert.equal(err.code, 'EOD_POST_BACKUP_REQUIRED');
            assert.equal(err.status, 500);
            return true;
        },
    );

    assert.deepEqual(stages, ['pre_eod', 'post_eod']);
    assert.equal(harness.getSetting('Last_EOD_Sweep'), harness.today);
    assert.match(String(harness.getSetting('Eod_Last_Backup_Error') || ''), /post/i);
    assert.equal(harness.countOpenTasks(), 0, 'purge may commit before post-backup');
});

test('Successful EOD produces both pre and post package ids in settings and return value', async (t) => {
    const harness = createEodHarness(t);
    if (!harness) return;

    const result = await harness.executeEODSweep(new Date('2026-08-04T18:00:00.000Z'), {
        skipOrderHistoryArchive: true,
        createBackupPackage: async ({ stage }) => harness.okPackage(stage, `pkg_${stage}_ok`),
        getDataRoot: () => 'C:\\fake-data-root',
    });

    assert.equal(result.success, true);
    assert.equal(result.storeDate, harness.today);
    assert.equal(result.pre_backup_package, 'pkg_pre_eod_ok');
    assert.equal(result.post_backup_package, 'pkg_post_eod_ok');
    assert.equal(harness.getSetting('Eod_Last_Pre_Backup_Package'), 'pkg_pre_eod_ok');
    assert.equal(harness.getSetting('Eod_Last_Post_Backup_Package'), 'pkg_post_eod_ok');
    assert.equal(harness.getSetting('Eod_Last_Backup_Error'), '');
    assert.ok(harness.getSetting('Eod_Last_Backup_Ok_At'), 'Eod_Last_Backup_Ok_At must be set');
    assert.equal(harness.getSetting('Last_EOD_Sweep'), harness.today);
});

test('same-day retry after post failure completes post-only without re-purging', async (t) => {
    const harness = createEodHarness(t);
    if (!harness) return;
    const when = new Date('2026-08-04T18:00:00.000Z');
    const stages = [];

    await assert.rejects(
        () => harness.executeEODSweep(when, {
            skipOrderHistoryArchive: true,
            createBackupPackage: async ({ stage }) => {
                stages.push(stage);
                if (stage === 'pre_eod') return harness.okPackage('pre_eod', 'pkg_pre_1');
                return harness.failPackage('post_eod', 'post verification failed');
            },
            getDataRoot: () => 'C:\\fake-data-root',
        }),
        (err) => err.code === 'EOD_POST_BACKUP_REQUIRED',
    );

    assert.equal(harness.getSetting('Last_EOD_Sweep'), harness.today);
    assert.equal(harness.getSetting('Eod_Last_Pre_Backup_Package'), 'pkg_pre_1');
    assert.equal(harness.countOpenTasks(), 0);

    const retryStages = [];
    const recovered = await harness.executeEODSweep(when, {
        skipOrderHistoryArchive: true,
        createBackupPackage: async ({ stage }) => {
            retryStages.push(stage);
            return harness.okPackage(stage, `pkg_${stage}_recovered`);
        },
        getDataRoot: () => 'C:\\fake-data-root',
    });

    assert.deepEqual(retryStages, ['post_eod'], 'retry must only create post package');
    assert.equal(recovered.success, true);
    assert.equal(recovered.recovered_post_backup, true);
    assert.equal(recovered.post_backup_package, 'pkg_post_eod_recovered');
    assert.equal(recovered.pre_backup_package, 'pkg_pre_1');
    assert.equal(harness.getSetting('Eod_Last_Post_Backup_Package'), 'pkg_post_eod_recovered');
    assert.equal(harness.getSetting('Eod_Last_Backup_Error'), '');
    assert.ok(harness.getSetting('Eod_Last_Backup_Ok_At'));
    assert.deepEqual(stages, ['pre_eod', 'post_eod']);
});

test('already swept with complete backup remains already_swept no-op', async (t) => {
    const harness = createEodHarness(t);
    if (!harness) return;
    const when = new Date('2026-08-04T18:00:00.000Z');
    const stages = [];

    const first = await harness.executeEODSweep(when, {
        skipOrderHistoryArchive: true,
        createBackupPackage: async ({ stage }) => {
            stages.push(stage);
            return harness.okPackage(stage, `pkg_${stage}_ok`);
        },
        getDataRoot: () => 'C:\\fake-data-root',
    });
    assert.equal(first.success, true);

    const secondStages = [];
    const second = await harness.executeEODSweep(when, {
        skipOrderHistoryArchive: true,
        createBackupPackage: async ({ stage }) => {
            secondStages.push(stage);
            return harness.okPackage(stage, `pkg_${stage}_again`);
        },
        getDataRoot: () => 'C:\\fake-data-root',
    });

    assert.deepEqual(second, {
        skipped: true,
        reason: 'already_swept',
        storeDate: harness.today,
    });
    assert.deepEqual(secondStages, [], 'complete already_swept must not create packages');
    assert.deepEqual(stages, ['pre_eod', 'post_eod']);
});

test('post-only retry failure still throws EOD_POST_BACKUP_REQUIRED', async (t) => {
    const harness = createEodHarness(t);
    if (!harness) return;
    const when = new Date('2026-08-04T18:00:00.000Z');

    await assert.rejects(
        () => harness.executeEODSweep(when, {
            skipOrderHistoryArchive: true,
            createBackupPackage: async ({ stage }) => {
                if (stage === 'pre_eod') return harness.okPackage('pre_eod', 'pkg_pre_1');
                return harness.failPackage('post_eod', 'first post fail');
            },
            getDataRoot: () => 'C:\\fake-data-root',
        }),
        (err) => err.code === 'EOD_POST_BACKUP_REQUIRED',
    );

    await assert.rejects(
        () => harness.executeEODSweep(when, {
            skipOrderHistoryArchive: true,
            createBackupPackage: async ({ stage }) => {
                assert.equal(stage, 'post_eod');
                return harness.failPackage('post_eod', 'retry post fail');
            },
            getDataRoot: () => 'C:\\fake-data-root',
        }),
        (err) => {
            assert.equal(err.code, 'EOD_POST_BACKUP_REQUIRED');
            assert.equal(err.status, 500);
            return true;
        },
    );

    assert.equal(harness.getSetting('Last_EOD_Sweep'), harness.today);
    assert.match(String(harness.getSetting('Eod_Last_Backup_Error') || ''), /retry post fail|post/i);
    assert.equal(harness.getSetting('Eod_Last_Post_Backup_Package') || '', '');
});

test('stale yesterday post id does not skip same-day post recovery', async (t) => {
    const harness = createEodHarness(t);
    if (!harness) return;
    const when = new Date('2026-08-04T18:00:00.000Z');

    // Simulate purge committed with today's pre, leftover yesterday post, and no error
    // (crash / old bug left post looking "complete").
    harness.db.run(
        "INSERT OR REPLACE INTO settings (setting_name,setting_value) VALUES ('Last_EOD_Sweep',?)",
        harness.today,
    );
    harness.db.run(
        "INSERT OR REPLACE INTO settings (setting_name,setting_value) VALUES ('Eod_Last_Pre_Backup_Package',?)",
        `pkg_pre_eod_${harness.today}_120000`,
    );
    harness.db.run(
        "INSERT OR REPLACE INTO settings (setting_name,setting_value) VALUES ('Eod_Last_Post_Backup_Package',?)",
        'pkg_post_eod_2026-08-03_235959',
    );
    harness.db.run(
        "INSERT OR REPLACE INTO settings (setting_name,setting_value) VALUES ('Eod_Last_Backup_Error','')",
    );
    harness.db.run(
        "INSERT OR REPLACE INTO settings (setting_name,setting_value) VALUES ('Eod_Last_Backup_Ok_At',?)",
        '2026-08-03T23:59:59.000Z',
    );

    const stages = [];
    const recovered = await harness.executeEODSweep(when, {
        skipOrderHistoryArchive: true,
        createBackupPackage: async ({ stage }) => {
            stages.push(stage);
            return harness.okPackage(stage, `pkg_${stage}_${harness.today}_recovered`);
        },
        getDataRoot: () => 'C:\\fake-data-root',
    });

    assert.deepEqual(stages, ['post_eod'], 'stale post must trigger post-only recovery, not already_swept');
    assert.equal(recovered.success, true);
    assert.equal(recovered.recovered_post_backup, true);
    assert.equal(
        harness.getSetting('Eod_Last_Post_Backup_Package'),
        `pkg_post_eod_${harness.today}_recovered`,
    );
    assert.equal(harness.getSetting('Eod_Last_Backup_Error'), '');
});

test('successful pre clears stale post package before purge', async (t) => {
    const harness = createEodHarness(t);
    if (!harness) return;

    harness.db.run(
        "INSERT OR REPLACE INTO settings (setting_name,setting_value) VALUES ('Eod_Last_Post_Backup_Package',?)",
        'pkg_post_eod_2026-08-03_old',
    );
    harness.db.run(
        "INSERT OR REPLACE INTO settings (setting_name,setting_value) VALUES ('Eod_Last_Backup_Ok_At',?)",
        '2026-08-03T12:00:00.000Z',
    );

    let postAfterPre = null;
    let okAtAfterPre = null;
    await assert.rejects(
        () => harness.executeEODSweep(new Date('2026-08-04T18:00:00.000Z'), {
            skipOrderHistoryArchive: true,
            createBackupPackage: async ({ stage }) => {
                if (stage === 'pre_eod') {
                    return harness.okPackage('pre_eod', `pkg_pre_eod_${harness.today}_1`);
                }
                // Observed on post call — after pre persistence, before post result applied.
                postAfterPre = harness.getSetting('Eod_Last_Post_Backup_Package');
                okAtAfterPre = harness.getSetting('Eod_Last_Backup_Ok_At');
                return harness.failPackage('post_eod', 'post fail after clear');
            },
            getDataRoot: () => 'C:\\fake-data-root',
        }),
        (err) => err.code === 'EOD_POST_BACKUP_REQUIRED',
    );

    assert.equal(postAfterPre, '', 'post id must be cleared when new pre is recorded');
    assert.equal(okAtAfterPre, '', 'ok_at must be cleared when new pre is recorded');
    assert.equal(harness.getSetting('Eod_Last_Pre_Backup_Package'), `pkg_pre_eod_${harness.today}_1`);
    assert.equal(harness.getSetting('Eod_Last_Post_Backup_Package') || '', '');
    assert.match(String(harness.getSetting('Eod_Last_Backup_Error') || ''), /post/i);
});

test('boot catch-up invokes same-day sweep for incomplete post backup', async (t) => {
    const Database = requireSqlite(t);
    if (!Database) return;
    const sqlite = new Database(':memory:');
    const db = wrap(sqlite);
    db.exec('CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT)');
    db.run("INSERT INTO settings VALUES ('Last_EOD_Sweep', ?)", STORE_DATE);
    t.after(() => sqlite.close());

    const calls = [];
    await catchUpMissedSweeps({
        db,
        getStoreDateStamp: () => STORE_DATE,
        logMsg: () => {},
        getSweep: () => async (when, opts) => {
            calls.push({ when, opts });
            return { success: true, recovered_post_backup: true };
        },
        getRhythm: () => () => {},
    });

    assert.equal(calls.length, 1, 'same-day incomplete path must call executeEODSweep once');
    assert.equal(calls[0].opts.skipOrderHistoryArchive, true);
});

test('boot catch-up still advances multi-day gaps before today', async (t) => {
    const Database = requireSqlite(t);
    if (!Database) return;
    const sqlite = new Database(':memory:');
    const db = wrap(sqlite);
    db.exec('CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT)');
    db.run("INSERT INTO settings VALUES ('Last_EOD_Sweep', '2026-08-01')");
    t.after(() => sqlite.close());

    const days = [];
    await catchUpMissedSweeps({
        db,
        getStoreDateStamp: (d) => {
            if (!d) return STORE_DATE;
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        },
        logMsg: () => {},
        getSweep: () => async (when, opts) => {
            const stamp = (() => {
                const y = when.getFullYear();
                const m = String(when.getMonth() + 1).padStart(2, '0');
                const day = String(when.getDate()).padStart(2, '0');
                return `${y}-${m}-${day}`;
            })();
            days.push({ stamp, skipArch: opts.skipOrderHistoryArchive });
            return { success: true };
        },
        getRhythm: () => () => {},
    });

    assert.deepEqual(
        days.map((d) => d.stamp),
        ['2026-08-02', '2026-08-03', '2026-08-04'],
    );
    assert.equal(days[0].skipArch, true);
    assert.equal(days[1].skipArch, true);
    assert.equal(days[2].skipArch, false);
});

test('eod-sweep route returns 409 EOD_BUSY when sweep is busy', () => {
    const src = fs.readFileSync(
        path.join(__dirname, '..', 'src', 'routes', 'manager', 'maintenance.cjs'),
        'utf8',
    );
    assert.match(src, /reason === 'busy'/);
    assert.match(src, /EOD_BUSY/);
    assert.match(src, /status\(409\)/);
    assert.match(src, /success:\s*false/);
});
