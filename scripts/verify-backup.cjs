#!/usr/bin/env node
'use strict';

/**
 * Backup restore drill for a single-store PoC.
 *
 * This never modifies the original backup. It copies the chosen backup to a temp
 * folder, opens the copy with SQLite, runs integrity checks, runs migrations
 * against the copy, verifies required app tables, and exits non-zero on failure.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { getBackupsDir } = require('../src/paths.cjs');
const { listBackupFiles, inspectBackupDatabase, isSafeBackupFilename } = require('../src/lib/backup-health.cjs');
const { REQUIRED_TABLES } = require('../src/lib/db-health.cjs');
const { runMigrations } = require('../src/migrations/runner.cjs');

function parseArgs(argv = process.argv.slice(2)) {
    const out = {
        backupsDir: process.env.TGP_BACKUPS_DIR || '',
        backup: '',
        json: false,
        skipMigrations: false,
        allowMissing: false,
    };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--backups-dir') out.backupsDir = argv[++i] || '';
        else if (a === '--backup') out.backup = argv[++i] || '';
        else if (a === '--json') out.json = true;
        else if (a === '--skip-migrations') out.skipMigrations = true;
        else if (a === '--allow-missing') out.allowMissing = true;
        else if (a === '--help' || a === '-h') out.help = true;
        else throw new Error(`Unknown argument: ${a}`);
    }
    return out;
}

function createDbWrapper(sqliteDb) {
    const stmtCache = new Map();
    const getStmt = (sql) => {
        if (stmtCache.has(sql)) return stmtCache.get(sql);
        const stmt = sqliteDb.prepare(sql);
        stmtCache.set(sql, stmt);
        return stmt;
    };
    return {
        all: (sql, ...params) => getStmt(sql).all(...params),
        get: (sql, ...params) => getStmt(sql).get(...params),
        run: (sql, ...params) => getStmt(sql).run(...params),
        exec: (sql) => sqliteDb.exec(sql),
        transaction: (fn) => sqliteDb.transaction(fn),
    };
}

function chooseBackup(backupsDir, requestedBackup) {
    if (requestedBackup) {
        if (/[\\/]/.test(String(requestedBackup))) {
            throw new Error(`Unsafe or unsupported backup filename: ${requestedBackup}`);
        }
        const name = path.basename(requestedBackup);
        if (!isSafeBackupFilename(name)) throw new Error(`Unsafe or unsupported backup filename: ${requestedBackup}`);
        const fullPath = path.join(backupsDir, name);
        return { file: name, fullPath };
    }

    const latest = listBackupFiles(backupsDir).find((b) => b.readable);
    if (!latest) throw new Error(`No readable generated backup found in ${backupsDir}`);
    return { file: latest.file, fullPath: path.join(backupsDir, latest.file) };
}

function migrateCopy(copyPath) {
    let Database;
    try {
        Database = require('better-sqlite3');
    } catch (e) {
        throw new Error(`better-sqlite3 unavailable: ${e.message || e}`);
    }

    const sqlite = new Database(copyPath, { fileMustExist: true });
    try {
        const db = createDbWrapper(sqlite);
        db.exec('PRAGMA foreign_keys = ON');
        runMigrations(db);
    } finally {
        sqlite.close();
    }
}

function runBackupDrill(opts = {}) {
    const backupsDir = path.resolve(opts.backupsDir || getBackupsDir());
    let chosen;
    try {
        chosen = chooseBackup(backupsDir, opts.backup || '');
    } catch (e) {
        if (opts.allowMissing && /No readable generated backup found/.test(e.message || String(e))) {
            return { ok: true, skipped: true, stage: 'skipped', backups_dir: backupsDir, reason: e.message || String(e) };
        }
        throw e;
    }
    if (!fs.existsSync(chosen.fullPath)) throw new Error(`Backup file not found: ${chosen.fullPath}`);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-backup-drill-'));
    const copyPath = path.join(tmpDir, chosen.file);
    fs.copyFileSync(chosen.fullPath, copyPath);

    const before = inspectBackupDatabase(copyPath, { requiredTables: REQUIRED_TABLES });
    if (!before.ok) {
        return {
            ok: false,
            stage: 'preflight',
            backup: chosen.file,
            backups_dir: backupsDir,
            copy_path: copyPath,
            inspection: before,
        };
    }

    if (!opts.skipMigrations) {
        try {
            migrateCopy(copyPath);
        } catch (e) {
            return {
                ok: false,
                stage: 'migrations',
                backup: chosen.file,
                backups_dir: backupsDir,
                copy_path: copyPath,
                inspection: before,
                error: e.message || String(e),
            };
        }
    }

    const after = inspectBackupDatabase(copyPath, { requiredTables: REQUIRED_TABLES });
    return {
        ok: after.ok,
        stage: after.ok ? 'complete' : 'post-migration-inspection',
        backup: chosen.file,
        backups_dir: backupsDir,
        copy_path: copyPath,
        inspection: after,
    };
}

function printHelp() {
    console.log(`
TGP backup restore drill

Usage:
  node scripts/verify-backup.cjs [--backups-dir <dir>] [--backup <file>] [--json]

Options:
  --backups-dir <dir>   Backup folder. Defaults to TGP_BACKUPS_DIR or the app backup folder.
  --backup <file>       Specific generated backup file to drill. Defaults to latest readable backup.
  --json                Print machine-readable JSON.
  --skip-migrations     Skip migration-on-copy step. Intended for isolated unit tests only.
  --allow-missing       Exit OK with skipped=true when no generated backup exists.
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
        const result = runBackupDrill({
            backupsDir: args.backupsDir,
            backup: args.backup,
            skipMigrations: args.skipMigrations,
            allowMissing: args.allowMissing,
        });
        if (args.json) {
            console.log(JSON.stringify(result, null, 2));
        } else if (result.ok) {
            if (result.skipped) {
                console.log(`OK backup drill skipped: ${result.reason}`);
            } else {
                console.log(`OK backup drill passed: ${result.backup}`);
                console.log(`   copy checked at: ${result.copy_path}`);
                console.log(`   tables: ${result.inspection.table_count}`);
            }
        } else {
            console.error(`FAIL backup drill failed at ${result.stage}: ${result.backup}`);
            console.error(`   ${result.error || result.inspection?.error || 'unknown error'}`);
        }
        process.exit(result.ok ? 0 : 1);
    } catch (e) {
        if (args?.json) console.log(JSON.stringify({ ok: false, error: e.message || String(e) }, null, 2));
        else console.error(`FAIL ${e.message || e}`);
        process.exit(1);
    }
}

module.exports = {
    parseArgs,
    createDbWrapper,
    chooseBackup,
    runBackupDrill,
};
