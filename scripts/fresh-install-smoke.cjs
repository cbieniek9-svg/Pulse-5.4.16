#!/usr/bin/env node
'use strict';

/**
 * Fresh install smoke test.
 *
 * Creates an empty temp TGP_DATA_DIR, imports the real app DB layer, runs normal
 * initialization, creates a generated backup, and verifies the backup drill.
 * This proves the packaged app can boot against a blank data folder.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv = process.argv.slice(2)) {
    const out = { json: false, keep: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--json') out.json = true;
        else if (a === '--keep') out.keep = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return out;
}

function getLatestMigrationVersion() {
    const { latestMigrationVersion } = require('../src/lib/release-manifest.cjs');
    return latestMigrationVersion();
}

async function runFreshInstallSmoke(opts = {}) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-fresh-install-'));
    process.env.TGP_DATA_DIR = dataDir;
    process.env.TGP_TEST_MODE = '1';

    const result = {
        ok: false,
        data_dir: dataDir,
        db_path: path.join(dataDir, 'tgp_ops.db'),
        backup: null,
        checks: {},
        error: null,
    };

    try {
        const { db, dbConn, initializeDailyRhythm, initializeSettings } = require('../src/db.cjs');
        const { REQUIRED_TABLES, checkDatabaseHealth } = require('../src/lib/db-health.cjs');
        const { ensureBackupsDir } = require('../src/paths.cjs');
        const { runBackupDrill } = require('./verify-backup.cjs');

        initializeSettings();
        initializeDailyRhythm();

        const latestMigration = getLatestMigrationVersion();
        const schemaVersion = db.get('SELECT MAX(version) AS version FROM schema_version')?.version || 0;
        result.checks.schema_version = { ok: Number(schemaVersion) >= latestMigration, value: Number(schemaVersion), latest: latestMigration };

        const existingTables = new Set(db.all("SELECT name FROM sqlite_master WHERE type='table'").map((r) => r.name));
        const missingTables = REQUIRED_TABLES.filter((name) => !existingTables.has(name));
        result.checks.required_tables = { ok: missingTables.length === 0, missing: missingTables };

        const settingsCount = db.get('SELECT COUNT(*) AS c FROM settings')?.c || 0;
        const staffCount = db.get('SELECT COUNT(*) AS c FROM staff')?.c || 0;
        const trainingModeEnabled = db.get(
            "SELECT setting_value FROM settings WHERE setting_name = 'Training_Mode_Enabled'",
        )?.setting_value;
        const activeTraining = db.get(
            `SELECT COUNT(*) AS c FROM staff
             WHERE UPPER(TRIM(name)) = 'TRAINING MODE' AND (active = 1 OR app_access = 1)`,
        )?.c || 0;
        const requireTvToken = db.get(
            "SELECT setting_value FROM settings WHERE setting_name = 'Require_TV_Device_Token'",
        )?.setting_value;
        // 5.4.11: fresh installs do not seed TRAINING MODE; staff may be empty until store setup.
        result.checks.seed_data = {
            ok: settingsCount > 0
                && trainingModeEnabled === '0'
                && requireTvToken === '1'
                && Number(activeTraining) === 0,
            settings: settingsCount,
            staff: staffCount,
            training_mode_enabled: trainingModeEnabled,
            require_tv_device_token: requireTvToken,
            active_training_staff: Number(activeTraining),
        };

        const backupsDir = ensureBackupsDir();
        const today = new Date().toISOString().slice(0, 10);
        const backupName = `tgp_ops_backup_${today}.db`;
        const backupPath = path.join(backupsDir, backupName);
        try { db.exec('PRAGMA wal_checkpoint(FULL)'); } catch (_) {}
        fs.copyFileSync(result.db_path, backupPath);
        result.backup = backupName;

        const drill = runBackupDrill({ backupsDir, backup: backupName, skipMigrations: false });
        result.checks.backup_drill = { ok: Boolean(drill.ok), stage: drill.stage, error: drill.error || drill.inspection?.error || null };

        const health = checkDatabaseHealth(db, { backupsDir, dbPath: result.db_path, maxBackupAgeHours: 72 });
        result.checks.health = { ok: health.status !== 'error', status: health.status, errors: health.errors || [], warnings: health.warnings || [] };

        result.ok = Object.values(result.checks).every((c) => c && c.ok !== false);

        if (dbConn && typeof dbConn.close === 'function') dbConn.close();
        return result;
    } catch (e) {
        result.error = e.stack || e.message || String(e);
        return result;
    } finally {
        if (!opts.keep) {
            try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch (_) {}
        }
    }
}

function printHelp() {
    console.log(`
TGP fresh install smoke test

Usage:
  node scripts/fresh-install-smoke.cjs [--json] [--keep]

Options:
  --json   Print machine-readable JSON.
  --keep   Keep the temp data folder for inspection.
`);
}

if (require.main === module) {
    let args;
    try {
        args = parseArgs();
        if (args.help) {
            printHelp();
            process.exit(0);
        }
    } catch (e) {
        console.error(`FAIL ${e.message || e}`);
        process.exit(1);
    }

    runFreshInstallSmoke(args)
        .then((result) => {
            if (args.json) console.log(JSON.stringify(result, null, 2));
            else if (result.ok) console.log(`OK fresh install smoke passed (${result.db_path})`);
            else {
                console.error('FAIL fresh install smoke failed');
                console.error(result.error || JSON.stringify(result.checks, null, 2));
            }
            process.exit(result.ok ? 0 : 1);
        })
        .catch((e) => {
            if (args.json) console.log(JSON.stringify({ ok: false, error: e.message || String(e) }, null, 2));
            else console.error(`FAIL ${e.message || e}`);
            process.exit(1);
        });
}

module.exports = {
    parseArgs,
    runFreshInstallSmoke,
};
