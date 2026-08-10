'use strict';

/**
 * Re-apply Excel archive seed data to an existing database (vendor contacts + rhythm est_mins).
 * Usage: node scripts/apply-excel-predecessor-baselines.cjs
 */
const path = require('path');
const Database = require('better-sqlite3');
const { getDbPath } = require('../src/paths.cjs');
const migration = require('../src/migrations/026_excel_archive_seed.cjs');

const dbPath = process.env.TGP_DATA_DIR
    ? path.join(process.env.TGP_DATA_DIR, 'tgp_ops.db')
    : getDbPath();

const dbConn = new Database(dbPath);
const db = {
    exec: (sql) => dbConn.exec(sql),
    get: (sql, ...p) => dbConn.prepare(sql).get(...p),
    all: (sql, ...p) => dbConn.prepare(sql).all(...p),
    run: (sql, ...p) => dbConn.prepare(sql).run(...p),
};

console.log('Applying Excel archive seed to', dbPath);
const apply = dbConn.transaction(() => {
    migration.up(db);
});
apply();
const count = db.get('SELECT COUNT(*) as n FROM vendor_contacts')?.n || 0;
console.log('vendor_contacts rows:', count);
console.log('Done.');
