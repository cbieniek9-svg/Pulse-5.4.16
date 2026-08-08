'use strict';

/** Richer CS CRM profile fields + activity timeline. */
module.exports = {
    name: '050_cs_crm_rich',
    up(db) {
        const cols = db.all(`PRAGMA table_info(cs_customers)`).map((c) => c.name);
        const add = (name, ddl) => {
            if (!cols.includes(name)) db.exec(`ALTER TABLE cs_customers ADD COLUMN ${ddl}`);
        };
        add('email', 'email TEXT NOT NULL DEFAULT \'\'');
        add('address_line', 'address_line TEXT NOT NULL DEFAULT \'\'');
        add('tags', 'tags TEXT NOT NULL DEFAULT \'\'');
        add('vip', 'vip INTEGER NOT NULL DEFAULT 0');
        add('alert_flag', 'alert_flag INTEGER NOT NULL DEFAULT 0');
        add('preferred_contact', 'preferred_contact TEXT NOT NULL DEFAULT \'\'');

        db.exec(`
            CREATE TABLE IF NOT EXISTS cs_customer_events (
                event_id TEXT PRIMARY KEY,
                customer_id TEXT NOT NULL,
                event_type TEXT NOT NULL DEFAULT 'note',
                body TEXT NOT NULL DEFAULT '',
                related_order_id TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                created_by TEXT NOT NULL DEFAULT ''
            );
            CREATE INDEX IF NOT EXISTS idx_cs_customer_events_customer
                ON cs_customer_events(customer_id, created_at DESC);
        `);
    },
};
