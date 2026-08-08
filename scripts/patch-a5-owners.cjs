#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const dbPath = process.argv[2] || path.join(__dirname, '..', '..', '..', 'tgp_ops.db');
if (!fs.existsSync(dbPath)) {
    console.error('DB not found:', dbPath);
    process.exit(1);
}

const db = new Database(dbPath);
const row = db.prepare("SELECT setting_value FROM settings WHERE setting_name = 'Zone_Section_Labels'").get();
const labels = JSON.parse(row.setting_value);
labels['map-a5'] = labels['map-a5'] || { label: 'A5', sublabel: 'COFFEE', sections: [] };
labels['map-a5'].sections = [
    { label: 'Coffee', owner: 'Ashley' },
    { label: 'Monin/Torani', owner: 'Luke' },
    { label: 'Wraps', owner: 'Chandler' },
];
db.prepare('UPDATE settings SET setting_value = ? WHERE setting_name = ?').run(
    JSON.stringify(labels),
    'Zone_Section_Labels',
);
db.close();
console.log('Patched A5 owners in', dbPath);
