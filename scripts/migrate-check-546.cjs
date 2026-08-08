'use strict';

/**
 * Copy live tgp_ops.db, apply migrations through 056, write verification JSON.
 * Run under Electron-as-Node: ELECTRON_RUN_AS_NODE=1 electron.exe scripts/migrate-check-546.cjs
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/migrations/runner.cjs');

const LIVE = path.resolve(__dirname, '../../../tgp_ops.db');
const COPY = path.resolve(__dirname, '../../../tgp_ops_migrate_check_546.db');
const RESULT = path.resolve(__dirname, '../../../migrate-check-546-result.json');

function wrapDb(raw) {
    return {
        all: (sql, ...params) => raw.prepare(sql).all(...params),
        get: (sql, ...params) => raw.prepare(sql).get(...params),
        run: (sql, ...params) => {
            const info = raw.prepare(sql).run(...params);
            return { changes: info.changes, lastInsertRowid: info.lastInsertRowid };
        },
        exec: (sql) => raw.exec(sql),
        transaction: (fn) => raw.transaction(fn),
        prepare: (sql) => raw.prepare(sql),
    };
}

async function copyLiveDb() {
    for (const p of [COPY, `${COPY}-wal`, `${COPY}-shm`]) {
        try { fs.unlinkSync(p); } catch (_) { /* ok */ }
    }

    const src = new Database(LIVE, { readonly: true, fileMustExist: true });
    src.pragma('busy_timeout = 15000');
    try {
        src.pragma('wal_checkpoint(PASSIVE)');
    } catch (_) { /* best effort */ }

    await src.backup(COPY);
    src.close();

    const verify = new Database(COPY, { fileMustExist: true });
    const tables = verify.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    let maxv = null;
    try {
        maxv = verify.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
    } catch (_) {
        maxv = null;
    }
    verify.close();

    if (!tables.includes('settings') || !tables.includes('schema_version')) {
        throw new Error(`Copy incomplete: tables=${tables.length}, has_settings=${tables.includes('settings')}, maxv=${maxv}`);
    }
    return { table_count: tables.length, before_schema_version: maxv };
}

async function main() {
    const out = {
        live: LIVE,
        copy: COPY,
        ok: false,
        error: null,
        before_schema_version: null,
        after_schema_version: null,
        table_count: null,
        checks: {},
    };

    try {
        if (!fs.existsSync(LIVE)) throw new Error(`Live DB missing: ${LIVE}`);

        const copied = await copyLiveDb();
        out.table_count = copied.table_count;
        out.before_schema_version = copied.before_schema_version;

        const raw = new Database(COPY);
        raw.pragma('journal_mode = WAL');
        raw.pragma('busy_timeout = 8000');
        const db = wrapDb(raw);

        runMigrations(db);
        out.after_schema_version = db.get('SELECT MAX(version) AS v FROM schema_version').v;

        const cols = (table) => db.all(`PRAGMA table_info(${table})`).map((c) => c.name);
        const lineCols = cols('receiving_report_lines');
        const dayCols = cols('receiving_report_day');
        const periodCols = cols('receiving_report_period_status');
        const snapCols = cols('receiving_report_period_snapshots');

        out.checks = {
            freight_on_lines: ['freight_meat', 'freight_produce', 'freight_grocery'].every((c) => lineCols.includes(c))
                && !lineCols.includes('freight_produce_shrink'),
            day_recon_and_cert: ['freight_recon_status', 'certified_at', 'cert_freight_verified'].every((c) => dayCols.includes(c)),
            period_costing: periodCols.includes('costing_method'),
            snapshot_json: snapCols.includes('snapshot_json') && snapCols.includes('snapshot_revision'),
            exception_table: !!db.get("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='receiving_report_exception_acks'"),
            audit_table: !!db.get("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='receiving_report_financial_audit'"),
            after_at_least_56: Number(out.after_schema_version) >= 56,
        };

        out.ok = Object.values(out.checks).every(Boolean);
        raw.close();
    } catch (err) {
        out.error = String(err && err.stack ? err.stack : err);
        out.ok = false;
    }

    fs.writeFileSync(RESULT, JSON.stringify(out, null, 2));
    console.log(JSON.stringify(out, null, 2));
    process.exit(out.ok ? 0 : 1);
}

main();
