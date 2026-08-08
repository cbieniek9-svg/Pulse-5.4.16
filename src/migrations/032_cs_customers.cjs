'use strict';

/**
 * CS customer CRM tables + setting (default OFF for gradual rollout).
 */
module.exports = {
    name: 'cs_customers',
    up(db) {
        db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Cs_Crm_Enabled', '0')");

        db.exec(`
            CREATE TABLE IF NOT EXISTS cs_customers (
                customer_id TEXT PRIMARY KEY,
                display_name TEXT NOT NULL,
                phone_digits TEXT NOT NULL,
                phone_display TEXT,
                notes TEXT DEFAULT '',
                prefs TEXT DEFAULT '',
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                last_order_at TEXT
            );
            CREATE UNIQUE INDEX IF NOT EXISTS idx_cs_customers_phone ON cs_customers(phone_digits);
            CREATE INDEX IF NOT EXISTS idx_cs_customers_name ON cs_customers(display_name);
        `);

        try {
            db.exec('ALTER TABLE special_orders ADD COLUMN customer_id TEXT');
        } catch (_) { /* column exists */ }

        try {
            db.exec('CREATE INDEX IF NOT EXISTS idx_special_orders_customer ON special_orders(customer_id)');
        } catch (_) { /* ignore */ }

        // Backfill: link betacs orders with usable phones to cs_customers
        const rows = db.all(
            `SELECT order_id, customer, contact, time_logged
             FROM special_orders
             WHERE source = 'betacs'
               AND (customer_id IS NULL OR customer_id = '')
               AND contact IS NOT NULL AND TRIM(contact) != ''`,
        ) || [];

        const byPhone = new Map();
        for (const row of rows) {
            const digits = String(row.contact || '').replace(/\D/g, '');
            if (digits.length < 7) continue;
            if (!byPhone.has(digits)) byPhone.set(digits, []);
            byPhone.get(digits).push(row);
        }

        const now = new Date().toISOString();
        for (const [digits, orders] of byPhone) {
            orders.sort((a, b) => String(a.time_logged || '').localeCompare(String(b.time_logged || '')));
            const latest = orders[orders.length - 1];
            const name = String(latest.customer || 'CUSTOMER').trim() || 'CUSTOMER';
            const phoneDisplay = String(latest.contact || '').trim();

            let existing = db.get('SELECT customer_id FROM cs_customers WHERE phone_digits = ?', digits);
            let customerId = existing?.customer_id;
            if (!customerId) {
                customerId = `CUS-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`.toUpperCase();
                db.run(
                    `INSERT INTO cs_customers
                     (customer_id, display_name, phone_digits, phone_display, notes, prefs, created_at, updated_at, last_order_at)
                     VALUES (?, ?, ?, ?, '', '', ?, ?, ?)`,
                    customerId,
                    name,
                    digits,
                    phoneDisplay,
                    now,
                    now,
                    latest.time_logged || now,
                );
            } else {
                db.run(
                    `UPDATE cs_customers SET display_name = ?, phone_display = ?, updated_at = ?,
                     last_order_at = COALESCE(?, last_order_at) WHERE customer_id = ?`,
                    name,
                    phoneDisplay,
                    now,
                    latest.time_logged || null,
                    customerId,
                );
            }
            for (const o of orders) {
                db.run('UPDATE special_orders SET customer_id = ? WHERE order_id = ?', customerId, o.order_id);
            }
        }
    },
};
