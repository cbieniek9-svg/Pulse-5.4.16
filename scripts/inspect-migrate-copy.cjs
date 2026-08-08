'use strict';

const Database = require('better-sqlite3');
const db = new Database('E:/Live/TGPV5/TGP_V5/tgp_ops_migrate_check_546.db', { readonly: true, fileMustExist: true });

function cols(table) {
    try {
        return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    } catch (e) {
        return [`ERR:${e.message}`];
    }
}

const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%receiving%' ORDER BY name").all();
const out = {
    receiving_tables: tables.map((t) => t.name),
    schema_versions: db.prepare('SELECT version, name FROM schema_version WHERE version >= 50 ORDER BY version').all(),
    lines: cols('edmonton_receiving_lines'),
    days: cols('edmonton_receiving_days'),
    periods: cols('edmonton_receiving_periods'),
    snaps: cols('edmonton_receiving_report_snapshots'),
};
require('fs').writeFileSync('E:/Live/TGPV5/TGP_V5/migrate-check-546-inspect.json', JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 2));
db.close();
