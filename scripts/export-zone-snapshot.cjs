#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const OUT = path.join(__dirname, '..', '..', 'Doc', 'standards-pdf', 'zone-snapshot.json');

function findDbPath(argvPath) {
    if (argvPath && fs.existsSync(argvPath)) return argvPath;
    const candidates = [
        process.env.TGP_OPS_DB,
        process.env.TGP_DATA_DIR && path.join(process.env.TGP_DATA_DIR, 'tgp_ops.db'),
        path.join(__dirname, '..', '..', '..', 'tgp_ops.db'),
        path.join(__dirname, '..', 'tgp_ops.db'),
        path.join(__dirname, '..', 'data', 'tgp_ops.db'),
    ].filter(Boolean);
    for (const p of candidates) {
        if (fs.existsSync(p)) return p;
    }
    return null;
}

function readSetting(db, name) {
    const row = db.prepare('SELECT setting_value FROM settings WHERE setting_name = ?').get(name);
    return row ? row.setting_value : '';
}

function main() {
    const argPath = process.argv[2];
    const dbPath = findDbPath(argPath);
    if (!dbPath) {
        console.error('No tgp_ops.db found. Usage:');
        console.error('  node scripts/export-zone-snapshot.cjs [path/to/tgp_ops.db]');
        console.error('Or set TGP_OPS_DB or TGP_DATA_DIR.');
        process.exit(1);
    }

    const db = new Database(dbPath, { readonly: true });
    const snapshot = {
        store_display_name: readSetting(db, 'Store_Display_Name') || readSetting(db, 'Store_Code') || 'TGP Store',
        exported_at: new Date().toISOString(),
        source: dbPath,
        Zone_Mapping: readSetting(db, 'Zone_Mapping'),
        Zone_Ownership: readSetting(db, 'Zone_Ownership'),
        Zone_Names: readSetting(db, 'Zone_Names'),
        Zone_Section_Labels: readSetting(db, 'Zone_Section_Labels'),
    };
    db.close();

    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(snapshot, null, 2), 'utf8');
    console.log('Wrote', OUT);
    console.log('Store:', snapshot.store_display_name);
    console.log('From:', dbPath);
}

main();
