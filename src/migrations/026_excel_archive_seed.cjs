'use strict';

const fs = require('fs');
const path = require('path');

function readJson(rel) {
    return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'store-templates', 'default', rel), 'utf8'));
}

function ensureVendorContactsTable(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS vendor_contacts (
            vendor TEXT PRIMARY KEY,
            category TEXT,
            rep TEXT,
            phone TEXT,
            email TEXT,
            order_days TEXT,
            delivery_days TEXT,
            cutoff TEXT,
            order_method TEXT,
            lead_time_days INTEGER,
            case_rules TEXT
        );
    `);
}

function seedVendorContacts(db) {
    ensureVendorContactsTable(db);
    const { contacts } = readJson('vendor-directory.json');
    contacts.forEach((c) => {
        db.run(
            `INSERT INTO vendor_contacts (
                vendor, category, rep, phone, email, order_days, delivery_days,
                cutoff, order_method, lead_time_days, case_rules
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(vendor) DO UPDATE SET
                category=excluded.category, rep=excluded.rep, phone=excluded.phone,
                email=excluded.email, order_days=excluded.order_days,
                delivery_days=excluded.delivery_days, cutoff=excluded.cutoff,
                order_method=excluded.order_method, lead_time_days=excluded.lead_time_days,
                case_rules=excluded.case_rules`,
            c.vendor,
            c.category || '',
            c.rep || '',
            c.phone || '',
            c.email || '',
            c.order_days || '',
            c.delivery_days || '',
            c.cutoff || '',
            c.order_method || '',
            c.lead_time_days,
            c.case_rules || '',
        );
    });
}

function applyRhythmEstMinsFromArchive(db) {
    const { rhythm_est_mins: map } = readJson('task-estimate-baselines.json');
    if (!map || typeof map !== 'object') return 0;
    let updated = 0;
    Object.entries(map).forEach(([detail, mins]) => {
        const est = Number(mins);
        if (!detail || !est) return;
        const res = db.run('UPDATE rhythm_tasks SET est_mins=? WHERE detail=? AND (est_mins IS NULL OR est_mins <= 15)', est, detail);
        if (res?.changes) updated += res.changes;
    });
    return updated;
}

function ensureLaborSettings(db) {
    const rows = [
        ['Labor_Soft_Overage_Threshold_Pct', '10'],
    ];
    rows.forEach(([name, value]) => {
        const row = db.get('SELECT setting_value FROM settings WHERE setting_name=?', name);
        if (!row) {
            db.run('INSERT INTO settings (setting_name, setting_value) VALUES (?, ?)', name, value);
        }
    });
}

module.exports = {
    name: 'excel_archive_seed',
    up(db) {
        seedVendorContacts(db);
        applyRhythmEstMinsFromArchive(db);
        ensureLaborSettings(db);
    },
};
