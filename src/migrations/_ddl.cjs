'use strict';

function columnNames(db, table) {
    return new Set((db.all(`PRAGMA table_info(${table})`) || []).map((row) => row.name));
}

function addColumn(db, table, name, ddl) {
    const cols = columnNames(db, table);
    if (cols.has(name)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
}

module.exports = { columnNames, addColumn };
