'use strict';

module.exports = {
    name: 'receiving_shrink_lines',
    up(db) {
        db.exec(`
            CREATE TABLE IF NOT EXISTS receiving_shrink_lines (
                shrink_id TEXT PRIMARY KEY,
                store_date TEXT NOT NULL,
                line_id TEXT,
                source_doc TEXT NOT NULL DEFAULT 'manual',
                source_filename TEXT NOT NULL DEFAULT '',
                invoice_number TEXT NOT NULL DEFAULT '',
                supplier_name TEXT NOT NULL DEFAULT '',
                sku TEXT NOT NULL DEFAULT '',
                description TEXT NOT NULL DEFAULT '',
                department TEXT NOT NULL DEFAULT '',
                quantity REAL NOT NULL DEFAULT 1,
                unit_cost REAL,
                extended_cost REAL NOT NULL DEFAULT 0,
                reason TEXT NOT NULL DEFAULT '',
                sort_order INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT,
                created_by TEXT NOT NULL DEFAULT '',
                updated_by TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_receiving_shrink_lines_date
                ON receiving_shrink_lines(store_date, sort_order);

            CREATE INDEX IF NOT EXISTS idx_receiving_shrink_lines_sku
                ON receiving_shrink_lines(sku);

            CREATE INDEX IF NOT EXISTS idx_receiving_shrink_lines_line
                ON receiving_shrink_lines(line_id);

            CREATE TABLE IF NOT EXISTS receiving_invoice_imports (
                import_id TEXT PRIMARY KEY,
                store_date TEXT NOT NULL,
                filename TEXT NOT NULL DEFAULT '',
                doc_type TEXT NOT NULL DEFAULT 'auto',
                line_id TEXT,
                shrink_count INTEGER NOT NULL DEFAULT 0,
                ocr_chars INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                created_by TEXT NOT NULL DEFAULT ''
            );

            CREATE INDEX IF NOT EXISTS idx_receiving_invoice_imports_date
                ON receiving_invoice_imports(store_date, created_at);
        `);
    },
};
