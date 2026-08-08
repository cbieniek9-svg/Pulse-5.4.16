'use strict';

const Database = require('better-sqlite3');
const db = new Database('E:/Live/TGPV5/TGP_V5/tgp_ops.db', { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 8000');
const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
let maxv = null;
try {
    maxv = db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
} catch (e) {
    maxv = e.message;
}
const result = {
    table_count: tables.length,
    has_settings: tables.includes('settings'),
    has_schema_version: tables.includes('schema_version'),
    max_version: maxv,
    sample: tables.slice(0, 20),
};
require('fs').writeFileSync('E:/Live/TGPV5/TGP_V5/live-db-inspect.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
db.close();
