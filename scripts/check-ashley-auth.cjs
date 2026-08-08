'use strict';
process.env.TGP_DATA_DIR = process.env.TGP_DATA_DIR || 'E:\\Live\\TGPV5\\TGP_V5';
const { db } = require('../src/db.cjs');

const staff = db.all(
    `SELECT id, name, active, app_access, role, permissions, shift_lead_eligible
       FROM staff
      ORDER BY name`,
) || [];

console.log('=== STAFF ROSTER ===');
staff.forEach((s) => {
    console.log([
        s.name,
        `role=${s.role}`,
        `active=${s.active}`,
        `app_access=${s.app_access}`,
        `perms=${s.permissions || '(none)'}`,
        `lead=${s.shift_lead_eligible}`,
    ].join(' | '));
});

console.log('\n=== RECENT APP ERRORS (auth-ish) ===');
try {
    const errs = db.all(
        `SELECT * FROM app_error_log
          ORDER BY id DESC
          LIMIT 40`,
    ) || [];
    errs.forEach((e) => {
        console.log(JSON.stringify({
            at: e.created_at || e.logged_at || e.timestamp,
            ctx: e.context || e.source,
            msg: e.message,
            status: e.status,
            user: e.session_user,
            role: e.session_role,
        }));
    });
} catch (err) {
    console.log('app_error_log unavailable:', err.message);
    const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%error%' OR name LIKE '%log%'") || [];
    console.log('candidate tables:', tables.map((t) => t.name).join(', '));
}

console.log('\n=== RECENT AUDIT (counts / expected_orders) ===');
try {
    const rows = db.all(
        `SELECT * FROM audit_ledger
          WHERE target_table IN ('counts','expected_orders') OR action_type LIKE '%count%'
          ORDER BY rowid DESC LIMIT 20`,
    ) || [];
    rows.forEach((r) => console.log(JSON.stringify(r)));
} catch (err) {
    console.log('audit_ledger query failed:', err.message);
    const cols = db.all('PRAGMA table_info(audit_ledger)') || [];
    console.log('audit_ledger cols:', cols.map((c) => c.name).join(', '));
}
