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

const OWNER_BY_LABEL = {
    Coffee: 'Ashley',
    'Monin/Torani': 'Luke',
    Wraps: 'Chandler',
};

const db = new Database(dbPath);
try {
    const apply = db.transaction(() => {
        const row = db.prepare("SELECT setting_value FROM settings WHERE setting_name = 'Zone_Section_Labels'").get();
        let labels;
        if (!row || row.setting_value == null || row.setting_value === '') {
            labels = {};
        } else {
            labels = JSON.parse(row.setting_value);
        }
        labels['map-a5'] = labels['map-a5'] || { label: 'A5', sublabel: 'COFFEE', sections: [] };
        const sections = Array.isArray(labels['map-a5'].sections) ? labels['map-a5'].sections : [];
        const byLabel = new Map(sections.map((s) => [String(s.label || ''), s]));
        for (const [label, owner] of Object.entries(OWNER_BY_LABEL)) {
            const existing = byLabel.get(label);
            if (existing) {
                existing.owner = owner;
            } else {
                sections.push({ label, owner });
            }
        }
        labels['map-a5'].sections = sections;

        const payload = JSON.stringify(labels);
        if (!row) {
            db.prepare('INSERT INTO settings (setting_name, setting_value) VALUES (?, ?)').run(
                'Zone_Section_Labels',
                payload,
            );
        } else {
            db.prepare('UPDATE settings SET setting_value = ? WHERE setting_name = ?').run(
                payload,
                'Zone_Section_Labels',
            );
        }
    });
    apply.immediate();
} finally {
    db.close();
}
console.log('Patched A5 owners in', dbPath);
