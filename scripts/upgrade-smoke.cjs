#!/usr/bin/env node
'use strict';

/**
 * Existing-store upgrade smoke test.
 *
 * Copies an existing store database into a temp TGP_DATA_DIR, imports the real
 * app DB layer so migrations run on the copy, then verifies data/metadata
 * survived. The source database is never mutated.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function parseArgs(argv = process.argv.slice(2)) {
    const out = {
        sourceDb: process.env.TGP_UPGRADE_SOURCE_DB || '',
        json: false,
        keep: false,
        allowMissingSource: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--source-db') out.sourceDb = argv[++i] || '';
        else if (a === '--json') out.json = true;
        else if (a === '--keep') out.keep = true;
        else if (a === '--allow-missing-source') out.allowMissingSource = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return out;
}

function defaultSourceCandidates() {
    const candidates = [];
    if (process.env.TGP_DATA_DIR) candidates.push(path.join(process.env.TGP_DATA_DIR, 'tgp_ops.db'));
    candidates.push(path.join(process.cwd(), 'tgp_ops.db'));
    candidates.push(path.join(__dirname, '..', 'tgp_ops.db'));
    return candidates;
}

function resolveSourceDb(requested) {
    if (requested) return path.resolve(requested);
    return defaultSourceCandidates().find((p) => fs.existsSync(p)) || '';
}

function getLatestMigrationVersion() {
    const { latestMigrationVersion } = require('../src/lib/release-manifest.cjs');
    return latestMigrationVersion();
}

async function runUpgradeSmoke(opts = {}) {
    const sourceDb = resolveSourceDb(opts.sourceDb);
    const result = {
        ok: false,
        skipped: false,
        source_db: sourceDb || null,
        data_dir: null,
        db_path: null,
        checks: {},
        error: null,
    };

    if (!sourceDb || !fs.existsSync(sourceDb)) {
        if (opts.allowMissingSource) {
            result.ok = true;
            result.skipped = true;
            result.error = 'No source DB found; upgrade smoke skipped.';
            return result;
        }
        result.error = 'No source DB found. Pass --source-db <path> or set TGP_UPGRADE_SOURCE_DB.';
        return result;
    }

    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-upgrade-smoke-'));
    result.data_dir = dataDir;
    result.db_path = path.join(dataDir, 'tgp_ops.db');
    fs.copyFileSync(sourceDb, result.db_path);

    process.env.TGP_DATA_DIR = dataDir;
    process.env.TGP_TEST_MODE = '1';

    try {
        const { db, dbConn, initializeDailyRhythm, initializeSettings } = require('../src/db.cjs');
        const { REQUIRED_TABLES, checkDatabaseHealth } = require('../src/lib/db-health.cjs');
        const { getBackupsDir } = require('../src/paths.cjs');

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
        result.checks.data_survived = { ok: settingsCount > 0 && staffCount > 0, settings: settingsCount, staff: staffCount };

        const auditTable = existingTables.has('manager_audit_log');
        const trustedDeviceColumns = db.all("PRAGMA table_info(trusted_devices)").map((r) => r.name);
        result.checks.patch_schema = {
            ok: auditTable && trustedDeviceColumns.includes('device_token_hash'),
            audit_table: auditTable,
            trusted_device_token_column: trustedDeviceColumns.includes('device_token_hash'),
        };

        const health = checkDatabaseHealth(db, { backupsDir: getBackupsDir(), dbPath: result.db_path, maxBackupAgeHours: 999999 });
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
TGP upgrade smoke test

Usage:
  node scripts/upgrade-smoke.cjs [--source-db <path>] [--json] [--keep] [--allow-missing-source]

Options:
  --source-db <path>       Existing store DB to copy and migrate.
  --allow-missing-source   Exit OK with skipped=true when no DB is available.
  --json                   Print machine-readable JSON.
  --keep                   Keep the temp migrated copy for inspection.
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

    runUpgradeSmoke(args)
        .then((result) => {
            if (args.json) console.log(JSON.stringify(result, null, 2));
            else if (result.skipped) console.log(`OK upgrade smoke skipped: ${result.error}`);
            else if (result.ok) console.log(`OK upgrade smoke passed (${result.source_db})`);
            else {
                console.error('FAIL upgrade smoke failed');
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
    resolveSourceDb,
    runUpgradeSmoke,
};
