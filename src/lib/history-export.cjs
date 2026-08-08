'use strict';

const fs = require('fs');
const path = require('path');
const { getDataRoot } = require('../paths.cjs');
const { buildReleaseManifest } = require('./release-manifest.cjs');
const { EXPORT_TABLES, buildTrendCsv, ensureDailyReportSnapshotsSchema } = require('./history-trends.cjs');
const { csvCell } = require('./csv-safe.cjs');
const {
    createBackupPackage: defaultCreateBackupPackage,
    BACKUP_VERIFICATION_FAILED,
} = require('./backup-package.cjs');

const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
        let c = i;
        for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
        table[i] = c >>> 0;
    }
    return table;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()) {
    const dt = new Date(date);
    const time = ((dt.getHours() & 0x1f) << 11) | ((dt.getMinutes() & 0x3f) << 5) | (Math.floor(dt.getSeconds() / 2) & 0x1f);
    const day = ((dt.getFullYear() - 1980) << 9) | ((dt.getMonth() + 1) << 5) | dt.getDate();
    return { time, day };
}

function u16(n) {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n & 0xffff, 0);
    return b;
}

function u32(n) {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n >>> 0, 0);
    return b;
}

/**
 * Build a minimal ZIP file using STORE method, no external dependencies.
 * Good enough for CSV/json/db exports and avoids adding a dependency to the PoC.
 */
function makeZip(entries) {
    const files = [];
    const central = [];
    let offset = 0;
    const now = dosDateTime();

    entries.forEach((entry) => {
        const nameBuf = Buffer.from(entry.name.replace(/\\/g, '/'), 'utf8');
        const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(String(entry.data ?? ''), 'utf8');
        const crc = crc32(data);

        const local = Buffer.concat([
            u32(0x04034b50),
            u16(20), // version needed
            u16(0),  // flags
            u16(0),  // method STORE
            u16(now.time),
            u16(now.day),
            u32(crc),
            u32(data.length),
            u32(data.length),
            u16(nameBuf.length),
            u16(0),
            nameBuf,
            data,
        ]);

        const centralHeader = Buffer.concat([
            u32(0x02014b50),
            u16(20), // version made by
            u16(20), // version needed
            u16(0),
            u16(0),
            u16(now.time),
            u16(now.day),
            u32(crc),
            u32(data.length),
            u32(data.length),
            u16(nameBuf.length),
            u16(0),
            u16(0),
            u16(0),
            u16(0),
            u32(0),
            u32(offset),
            nameBuf,
        ]);

        files.push(local);
        central.push(centralHeader);
        offset += local.length;
    });

    const centralDir = Buffer.concat(central);
    const end = Buffer.concat([
        u32(0x06054b50),
        u16(0),
        u16(0),
        u16(entries.length),
        u16(entries.length),
        u32(centralDir.length),
        u32(offset),
        u16(0),
    ]);

    return Buffer.concat([...files, centralDir, end]);
}

function safeAll(db, sql, ...params) {
    try { return db.all(sql, ...params) || []; } catch (_) { return []; }
}

function tableExists(db, name) {
    try { return Boolean(db.get("SELECT name FROM sqlite_master WHERE type='table' AND name=?", name)?.name); }
    catch (_) { return false; }
}

function rowsToCsv(rows) {
    if (!rows.length) return '';
    const headers = Object.keys(rows[0]);
    return [headers.join(','), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(','))].join('\n');
}

function exportTableCsv(db, tableName) {
    if (!/^[a-zA-Z0-9_]+$/.test(tableName) || !tableExists(db, tableName)) return '';
    const rows = safeAll(db, `SELECT * FROM ${tableName}`);
    return rowsToCsv(rows);
}

function walkFiles(rootDir) {
    const out = [];
    if (!rootDir || !fs.existsSync(rootDir)) return out;
    const stack = [rootDir];
    while (stack.length) {
        const current = stack.pop();
        const entries = fs.readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
            const full = path.join(current, entry.name);
            if (entry.isDirectory()) stack.push(full);
            else if (entry.isFile()) out.push(full);
        }
    }
    return out.sort((a, b) => a.localeCompare(b));
}

function throwVerificationFailed(pkg) {
    const code = (pkg && pkg.code) || BACKUP_VERIFICATION_FAILED;
    const detail = (pkg && pkg.error) || 'Backup verification failed';
    const err = new Error(`${code}: ${detail}`);
    err.code = code;
    throw err;
}

/**
 * Include verified ops (+ package sidecars when present) under database/.
 */
function appendVerifiedPackageEntries(entries, pkg) {
    if (!pkg?.opsDbPath || !fs.existsSync(pkg.opsDbPath)) {
        throwVerificationFailed({
            ok: false,
            code: BACKUP_VERIFICATION_FAILED,
            error: 'verified ops database path missing',
        });
    }

    entries.push({
        name: 'database/tgp_ops.db',
        data: fs.readFileSync(pkg.opsDbPath),
    });

    const packageDir = pkg.directory;
    if (!packageDir || !fs.existsSync(packageDir)) return;

    for (const file of walkFiles(packageDir)) {
        const rel = path.relative(packageDir, file).split(path.sep).join('/');
        if (!rel || rel === 'tgp_ops.db') continue;
        entries.push({
            name: `database/${rel}`,
            data: fs.readFileSync(file),
        });
    }
}

async function buildHistoryExportZip(db, opts = {}) {
    if (typeof db.exec === 'function') {
        try { ensureDailyReportSnapshotsSchema(db); } catch (_) {}
    }

    const now = opts.now || new Date();
    const stamp = now.toISOString().replace(/[:.]/g, '-');
    const entries = [];

    const createPkg = typeof opts.createBackupPackage === 'function'
        ? opts.createBackupPackage
        : defaultCreateBackupPackage;
    const dataRoot = opts.dataRoot || getDataRoot();

    let pkg;
    try {
        pkg = await createPkg({
            db,
            dataRoot,
            stage: 'history_export',
            actor: opts.actor || '',
            labelDate: opts.labelDate,
            now,
        });
    } catch (e) {
        throwVerificationFailed({
            ok: false,
            code: e?.code || BACKUP_VERIFICATION_FAILED,
            error: e?.message || String(e),
        });
    }

    if (!pkg || pkg.ok !== true) {
        throwVerificationFailed(pkg);
    }

    appendVerifiedPackageEntries(entries, pkg);

    entries.push({
        name: 'release-manifest.json',
        data: JSON.stringify(buildReleaseManifest({ db }), null, 2),
    });

    entries.push({
        name: 'README.txt',
        data: [
            'TGP Center Store Full History Export',
            `Created: ${now.toISOString()}`,
            '',
            'Includes a verified backup-package database copy (and sidecars when present),',
            'release manifest, trend CSV, and table CSV exports.',
            'The old internal shrink_log table is exported as outdated_items.csv for report clarity.',
            '',
        ].join('\n'),
    });

    const endDate = opts.endDate || now.toISOString().slice(0, 10);
    entries.push({
        name: 'csv/trends_daily_snapshots.csv',
        data: buildTrendCsv(db, { endDate, days: Number(opts.days || 365) }),
    });

    EXPORT_TABLES.forEach((table) => {
        const csv = exportTableCsv(db, table);
        const exportName = table === 'shrink_log' ? 'outdated_items' : table;
        entries.push({ name: `csv/${exportName}.csv`, data: csv || '' });
    });

    return {
        filename: `tgp_full_history_${stamp.slice(0, 10)}.zip`,
        buffer: makeZip(entries),
        entries: entries.map((e) => e.name),
        packageId: pkg.packageId || null,
    };
}

module.exports = {
    crc32,
    makeZip,
    buildHistoryExportZip,
    exportTableCsv,
};
