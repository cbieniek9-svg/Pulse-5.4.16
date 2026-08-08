'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let Database;
try {
    Database = require('better-sqlite3');
} catch (e) {
    const msg = String(e?.message || e);
    throw new Error(
        'SQLite native module missing for pulse inventory DB. '
        + 'Run npm run rebuild:electron from resources/app. '
        + `Detail: ${msg}`,
    );
}

const { getPulseInventoryDbPath } = require('../paths.cjs');

let inventoryDb = null;

function tableExists(db, name) {
    const row = db.prepare(
        "SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name = ?",
    ).get(name);
    return !!row;
}

function migrateInventorySchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS count_sessions (
            id TEXT PRIMARY KEY,
            location TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'open',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            created_by TEXT,
            exported_at DATETIME,
            export_note TEXT
        );
        CREATE TABLE IF NOT EXISTS count_lines (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            session_id TEXT NOT NULL,
            upc TEXT NOT NULL,
            quantity INTEGER NOT NULL,
            scanned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME,
            FOREIGN KEY (session_id) REFERENCES count_sessions(id)
        );
        CREATE INDEX IF NOT EXISTS idx_count_lines_session
            ON count_lines (session_id, scanned_at DESC);
        CREATE INDEX IF NOT EXISTS idx_count_sessions_status
            ON count_sessions (status, exported_at DESC, created_at DESC);
    `);

    // Purpose of walk: location (aisle cycle) vs backstock (Safeway-style fill stock).
    const cols = new Set(
        (db.prepare('PRAGMA table_info(count_sessions)').all() || []).map((c) => c.name),
    );
    if (!cols.has('session_type')) {
        db.exec(`ALTER TABLE count_sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'location'`);
    }
    // Cached pick list + clean order from finalize (survives leaving the screen).
    if (!cols.has('report_json')) {
        db.exec(`ALTER TABLE count_sessions ADD COLUMN report_json TEXT`);
    }
    db.exec(`
        CREATE INDEX IF NOT EXISTS idx_count_sessions_type
            ON count_sessions (session_type, status, created_at DESC);
    `);

    // UOM + write-time price snapshots on count lines.
    const lineCols = new Set(
        (db.prepare('PRAGMA table_info(count_lines)').all() || []).map((c) => c.name),
    );
    if (!lineCols.has('uom')) {
        db.exec(`ALTER TABLE count_lines ADD COLUMN uom TEXT NOT NULL DEFAULT 'case'`);
    }
    if (!lineCols.has('unit_cost')) {
        db.exec('ALTER TABLE count_lines ADD COLUMN unit_cost REAL');
    }
    if (!lineCols.has('unit_retail')) {
        db.exec('ALTER TABLE count_lines ADD COLUMN unit_retail REAL');
    }
    if (!lineCols.has('department')) {
        db.exec(`ALTER TABLE count_lines ADD COLUMN department TEXT NOT NULL DEFAULT ''`);
    }
    if (!lineCols.has('priced_at')) {
        db.exec(`ALTER TABLE count_lines ADD COLUMN priced_at TEXT NOT NULL DEFAULT ''`);
    }
    if (!lineCols.has('item_description')) {
        db.exec(`ALTER TABLE count_lines ADD COLUMN item_description TEXT NOT NULL DEFAULT ''`);
    }

    // Durable on-hand memory after CLOSE & COMMIT on a backstock walk.
    // Order drafts subtract from this — not from still-open scan sessions.
    db.exec(`
        CREATE TABLE IF NOT EXISTS backstock_on_hand (
            upc TEXT NOT NULL,
            location TEXT NOT NULL,
            quantity INTEGER NOT NULL DEFAULT 0,
            updated_at TEXT,
            source_session_id TEXT,
            PRIMARY KEY (upc, location)
        );
        CREATE INDEX IF NOT EXISTS idx_backstock_on_hand_loc
            ON backstock_on_hand (location, upc);
    `);

    // One-time migrate from original staged_counts staging table.
    if (tableExists(db, 'staged_counts')) {
        const legacyCount = db.prepare('SELECT COUNT(*) AS c FROM staged_counts').get()?.c || 0;
        if (legacyCount > 0) {
            const sessionId = `S-${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
            db.prepare(`
                INSERT INTO count_sessions (id, location, status, created_by, session_type)
                VALUES (?, 'MIGRATED', 'open', 'system', 'location')
            `).run(sessionId);
            db.prepare(`
                INSERT INTO count_lines (session_id, upc, quantity, scanned_at)
                SELECT ?, upc, quantity, scanned_at FROM staged_counts
                ORDER BY id ASC
            `).run(sessionId);
        }
        db.exec('DROP TABLE IF EXISTS staged_counts');
    }
}

/**
 * Isolated better-sqlite3 connection for cycle-count staging + history.
 * Never shares a handle with tgp_ops.db.
 */
function getPulseInventoryDb() {
    if (inventoryDb) return inventoryDb;

    const dbPath = getPulseInventoryDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });

    inventoryDb = new Database(dbPath);
    inventoryDb.pragma('journal_mode = WAL');
    inventoryDb.pragma('busy_timeout = 5000');
    inventoryDb.pragma('synchronous = NORMAL');
    inventoryDb.pragma('foreign_keys = ON');

    migrateInventorySchema(inventoryDb);

    return inventoryDb;
}

function closePulseInventoryDb() {
    if (inventoryDb) {
        try { inventoryDb.close(); } catch (_) { /* ignore */ }
        inventoryDb = null;
    }
}

module.exports = {
    getPulseInventoryDb,
    closePulseInventoryDb,
    migrateInventorySchema,
};
