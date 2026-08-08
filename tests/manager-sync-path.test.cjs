'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { buildManagerHubMeta } = require('../src/lib/manager-hub-meta.cjs');
const { buildDailyDirectionDraft } = require('../src/lib/daily-direction.cjs');
const { buildScheduleHealthExceptions } = require('../src/lib/schedule-health.cjs');
const { vendorScheduleWeekday } = require('../src/lib/store-time.cjs');

function requireSqlite(t) {
    try {
        return require('better-sqlite3');
    } catch (e) {
        t.skip(`better-sqlite3 is not loadable: ${e.message || e}`);
        return null;
    }
}

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-mgr-sync-'));
}

function createDb(t) {
    const Database = requireSqlite(t);
    if (!Database) return null;
    try {
        const dir = tempDir();
        const sqlite = new Database(path.join(dir, 'tgp_ops.db'));
    const db = {
        all(sql, ...params) { return sqlite.prepare(sql).all(...params); },
        get(sql, ...params) { return sqlite.prepare(sql).get(...params); },
        run(sql, ...params) { return sqlite.prepare(sql).run(...params); },
        exec(sql) { sqlite.exec(sql); },
    };
    db.exec(`
        CREATE TABLE settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);
        CREATE TABLE tasks (
            task_id TEXT PRIMARY KEY, task_detail TEXT, status TEXT, priority TEXT,
            zone TEXT, assigned_to TEXT, est_mins INTEGER, time_submitted TEXT,
            time_closed TEXT, closed_by TEXT, related_id TEXT, start_time TEXT
        );
        CREATE TABLE staff (id INTEGER PRIMARY KEY, name TEXT, active INTEGER, role TEXT);
        CREATE TABLE rhythm_tasks (id TEXT PRIMARY KEY, day TEXT, detail TEXT, priority TEXT, zone TEXT, est_mins INTEGER);
        CREATE TABLE vendor_schedule (id TEXT PRIMARY KEY, day TEXT, vendor TEXT);
        CREATE TABLE expected_orders (
            exp_id TEXT PRIMARY KEY, vendor TEXT, expected_day TEXT, status TEXT,
            category TEXT, arrived INTEGER
        );
        CREATE TABLE kill_dates (
            id TEXT PRIMARY KEY, item TEXT, kill_date TEXT, zone TEXT, status TEXT,
            logged_by TEXT, closed_by TEXT, time_closed TEXT, item_code TEXT
        );
        CREATE TABLE special_orders (
            order_id TEXT PRIMARY KEY, customer TEXT, item TEXT, contact TEXT,
            location TEXT, status TEXT, logged_by TEXT, time_logged TEXT,
            closed_by TEXT, time_closed TEXT
        );
        -- Mirrors src/db.cjs plus migrations 002/003/005/009; the briefing selects the
        -- full metric set, so a trimmed fixture fails on columns every real DB has.
        CREATE TABLE shift_order_history (
            store_date TEXT PRIMARY KEY, order_start TEXT, order_end TEXT, recorded_at TEXT,
            grocery_pieces INTEGER DEFAULT 0, frozen_pieces INTEGER DEFAULT 0,
            hardware_pieces INTEGER DEFAULT 0, total_pieces INTEGER DEFAULT 0,
            staff_count INTEGER DEFAULT 1, standard_hours REAL DEFAULT 0,
            actual_order_minutes INTEGER DEFAULT 0, actual_pieces_per_hour REAL DEFAULT 0,
            break_deduction_hours_per_person REAL DEFAULT 0, adjusted_labor_hours REAL DEFAULT 0,
            adjusted_per_person_pph REAL DEFAULT 0, raw_clock_minutes INTEGER DEFAULT 0,
            spans_calendar_day INTEGER DEFAULT 0, exception_reason TEXT DEFAULT '',
            staff_roster TEXT DEFAULT ''
        );
        CREATE TABLE staff_shifts (
            id TEXT PRIMARY KEY, staff_name TEXT, shift_date TEXT, start_time TEXT,
            end_time TEXT, role TEXT, department TEXT, notes TEXT, source_file TEXT,
            imported_at TEXT, imported_by TEXT
        );
        CREATE TABLE daily_direction (
            store_date TEXT PRIMARY KEY, floor_message TEXT, floor_message_edited INTEGER,
            posted_at TEXT, posted_by TEXT, posted_msg_id TEXT, posted_snapshot_json TEXT,
            must_wins_json TEXT, walk_notes_json TEXT, hidden_risk_ids_json TEXT,
            risk_order_json TEXT, status_override TEXT, manager_only_notes TEXT,
            shift_update_draft_json TEXT, amendment_snoozed_until TEXT,
            amendment_dismissed_fingerprint TEXT, updated_at TEXT, updated_by TEXT
        );
        CREATE TABLE shift_updates (
            id INTEGER PRIMARY KEY AUTOINCREMENT, store_date TEXT, sequence_num INTEGER,
            message TEXT, triggers_json TEXT, posted_at TEXT, posted_by TEXT,
            posted_msg_id TEXT, snapshot_json TEXT
        );
    `);
    db.run("INSERT INTO settings (setting_name, setting_value) VALUES ('Store_Timezone', 'America/Edmonton')");
    db.run("INSERT INTO settings (setting_name, setting_value) VALUES ('Active_Manager', 'Ashley')");
    db.run("INSERT INTO vendor_schedule (id, day, vendor) VALUES ('V-Sunday-TGP', 'Sunday', 'TGP')");
    db.run("INSERT INTO staff (id, name, active, role) VALUES (1, 'Ashley', 1, 'Premium Clerk')");
    db.run(`
        INSERT INTO staff_shifts (id, staff_name, shift_date, start_time, end_time, role, department, imported_at, imported_by)
        VALUES ('S-1', 'Ashley', '2026-07-12', '07:00', '15:00', 'Premium', 'Premium', '2026-07-12', 'test')
    `);
    return { db, sqlite, dir };
    } catch (e) {
        t.skip(`better-sqlite3 native module unavailable: ${e.message || e}`);
        return null;
    }
}

test('vendorScheduleWeekday maps clock SUNDAY to vendor_schedule Sunday', () => {
    assert.equal(vendorScheduleWeekday('SUNDAY', '2026-07-12'), 'Sunday');
    assert.equal(vendorScheduleWeekday('Sunday', '2026-07-12'), 'Sunday');
});

test('buildDailyDirectionDraft finds Sunday vendors when clock weekday is uppercase', () => {
    const db = {
        all(sql, ...params) {
            if (sql.includes('vendor_schedule')) {
                const day = params[0];
                return day === 'Sunday' ? [{ vendor: 'TGP' }] : [];
            }
            if (sql.includes('expected_orders')) return [];
            if (sql.includes('daily_direction')) return null;
            if (sql.includes('shift_updates')) return [];
            if (sql.includes('FROM tasks')) return [];
            return [];
        },
        get() { return null; },
    };
    const draft = buildDailyDirectionDraft(db, {
        storeDate: '2026-07-12',
        clock: { storeWeekday: 'SUNDAY', storeTime: '18:13' },
        kpis: {},
        settings: { Store_Timezone: 'America/Edmonton' },
        managerExceptions: [],
        reportActions: [],
        orderDayBriefing: { store_date: '2026-07-12', weekday: 'Sunday' },
        killWarnings: [],
        openTasks: [],
        getStoreDateStamp: () => '2026-07-12',
    });
    assert.deepEqual(draft.day_context.vendors, ['TGP']);
});

test('buildManagerHubMeta survives staff table without shift_lead_eligible column', (t) => {
    const ctx = createDb(t);
    if (!ctx) return;
    const { db, sqlite } = ctx;
    const meta = buildManagerHubMeta(db, {
        today: '2026-07-12',
        clock: { storeWeekday: 'SUNDAY', storeTime: '18:13' },
        kpis: { pieces_on_order: 0 },
        settings: db.all('SELECT * FROM settings').reduce((acc, row) => {
            acc[row.setting_name] = row.setting_value;
            return acc;
        }, {}),
        cachedHeatMap: {},
        presenceConfig: { enabled: false },
        getStoreDateStamp: () => '2026-07-12',
    });
    assert.ok(meta);
    assert.ok(Array.isArray(meta.report_actions));
    sqlite.close();
});

test('buildScheduleHealthExceptions does not query missing shift_lead_eligible column', (t) => {
    const ctx = createDb(t);
    if (!ctx) return;
    const { db, sqlite } = ctx;
    const items = buildScheduleHealthExceptions(db, {
        storeDate: '2026-07-12',
        storeTime: '18:13',
        settings: { Active_Manager: 'Ashley' },
    });
    assert.ok(Array.isArray(items));
    sqlite.close();
});
