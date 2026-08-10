const path = require('path');
const fs = require('fs');

let Database;
try {
    Database = require('better-sqlite3');
} catch (e) {
    const msg = String(e?.message || e);
    if (msg.includes('NODE_MODULE_VERSION') || msg.includes('Could not locate the bindings file')) {
        const isElectron = Boolean(process.versions?.electron);
        const tip = isElectron
            ? 'This process is Electron (ABI 145) — run: npm run rebuild:electron   (or scripts\\fix-native-modules.cmd)'
            : 'This process is system Node — store/service need Electron ABI 145. Run: npm run rebuild:electron (not rebuild:node)';
        throw new Error(
            'SQLite native module is missing or built for the wrong runtime. '
            + tip
            + ' From resources/app on a PC with Node installed. '
            + 'Windows service + desktop always use Electron ABI 145 (service runs ELECTRON_RUN_AS_NODE). '
            + 'Do not npm install on the store PC. '
            + `Detail: ${msg}`,
        );
    }
    throw e;
}

const { getDbPath } = require('./paths.cjs');
const dbPath = getDbPath();
const dbConn = new Database(dbPath);
dbConn.pragma('journal_mode = WAL');
dbConn.pragma('busy_timeout = 5000');
dbConn.pragma('foreign_keys = ON');
/** WAL + NORMAL balances durability and write throughput vs FULL synchronous. */
dbConn.pragma('synchronous = NORMAL');
/** Negative value = page cache size in KiB (helps read-heavy /api/sync). */
dbConn.pragma('cache_size = -24000');

const stmtCache = new Map();
const getStmt = (sql) => {
  if (stmtCache.has(sql)) {
    // M4 FIX: LRU - Move to end of Map (most recent) on hit
    const stmt = stmtCache.get(sql);
    stmtCache.delete(sql);
    stmtCache.set(sql, stmt);
    return stmt;
  }
  
  if (stmtCache.size >= 256) { // M4 FIX: Increased cap to 256
    const firstKey = stmtCache.keys().next().value;
    stmtCache.delete(firstKey);
  }
  
  const stmt = dbConn.prepare(sql);
  stmtCache.set(sql, stmt);
  return stmt;
};

const db = {
  all: (sql, ...params) => getStmt(sql).all(...params),
  get: (sql, ...params) => getStmt(sql).get(...params),
  run: (sql, ...params) => getStmt(sql).run(...params),
  exec: (sql) => dbConn.exec(sql),
  transaction: (fn) => dbConn.transaction(fn),
  
  // Named helpers
  findStaffByName: (name) => db.get("SELECT name, role, pin, pin_hashed, permissions, active, app_access FROM staff WHERE name = ?", name),
  getSettings: () => db.all("SELECT * FROM settings").reduce((acc, s) => ({...acc, [s.setting_name]: s.setting_value}), {}),
  getCounts: () => db.get("SELECT * FROM counts WHERE id = 1"),
  upsertAudit: (id, ts, user, action, table, details) => 
    db.run("INSERT INTO audit_ledger (id, timestamp, user, action_type, target_table, details) VALUES (?, ?, ?, ?, ?, ?)", id, ts, user, action, table, details),
  
  // Hardware specific DAL
  getHardwareOrder: (id) => getStmt("SELECT * FROM expected_orders WHERE exp_id = ?").get(id),
  updateHardwareArrive: (id, actor, ts) => getStmt("UPDATE expected_orders SET arrived = 1, arrived_at = ?, arrived_by = ? WHERE exp_id = ?").run(ts, actor, id),
  updateHardwareUnarrive: (id) => getStmt("UPDATE expected_orders SET arrived = 0, arrived_at = NULL, arrived_by = NULL WHERE exp_id = ?").run(id),
  incrementHardwareCount: (pieces) => getStmt("UPDATE counts SET hardware = hardware + ? WHERE id = 1").run(pieces),
  decrementHardwareCount: (pieces) => getStmt("UPDATE counts SET hardware = hardware - ? WHERE id = 1").run(pieces),
  
  // Feature Flags
  isFlagOn: (name) => {
    const row = getStmt("SELECT setting_value FROM settings WHERE setting_name = ?").get(`flag.${name}`);
    return row && row.setting_value === '1';
  },
  backup: (dest) => dbConn.backup(dest),
  close: () => dbConn.close()
};

// --- INITIALIZE SCHEMA ---
db.exec(`
  CREATE TABLE IF NOT EXISTS tasks (task_id TEXT PRIMARY KEY, task_detail TEXT, status TEXT, priority TEXT, zone TEXT, assigned_to TEXT, est_mins INTEGER DEFAULT 15, time_submitted TEXT, time_closed TEXT, closed_by TEXT, related_id TEXT, start_time TEXT);
  CREATE TABLE IF NOT EXISTS oos (oos_id TEXT PRIMARY KEY, zone TEXT, hole_count INTEGER, notes TEXT, status TEXT, logged_by TEXT, time_logged TEXT, closed_by TEXT, time_closed TEXT);
  CREATE TABLE IF NOT EXISTS special_orders (order_id TEXT PRIMARY KEY, customer TEXT, item TEXT, contact TEXT, location TEXT, status TEXT, logged_by TEXT, time_logged TEXT, closed_by TEXT, time_closed TEXT);
  CREATE TABLE IF NOT EXISTS expected_orders (exp_id TEXT PRIMARY KEY, vendor TEXT, expected_day TEXT, status TEXT, logged_by TEXT, closed_by TEXT, time_closed TEXT, category TEXT DEFAULT 'general', pieces INTEGER DEFAULT 0, arrived INTEGER DEFAULT 0, arrived_at TEXT, arrived_by TEXT, item TEXT, departed_at TEXT, departed_by TEXT, create_task INTEGER DEFAULT 0, invoice_ref TEXT);
  CREATE TABLE IF NOT EXISTS staff (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, active INTEGER DEFAULT 1, pin TEXT DEFAULT '1234', app_access INTEGER DEFAULT 1, role TEXT DEFAULT 'Clerk', pin_hashed INTEGER DEFAULT 0, experimental_mode INTEGER DEFAULT 0, permissions TEXT DEFAULT '');
  CREATE TABLE IF NOT EXISTS ticker (msg_id TEXT PRIMARY KEY, message TEXT);
  CREATE TABLE IF NOT EXISTS counts (id INTEGER PRIMARY KEY, grocery INTEGER DEFAULT 0, frozen INTEGER DEFAULT 0, hardware INTEGER DEFAULT 0, staff INTEGER DEFAULT 1);
  CREATE TABLE IF NOT EXISTS settings (setting_name TEXT PRIMARY KEY, setting_value TEXT);
  CREATE TABLE IF NOT EXISTS rhythm_tasks (id TEXT PRIMARY KEY, day TEXT, detail TEXT, priority TEXT, zone TEXT, est_mins INTEGER DEFAULT 15, assign_bucket TEXT NOT NULL DEFAULT '');
  CREATE TABLE IF NOT EXISTS vendor_schedule (id TEXT PRIMARY KEY, day TEXT, vendor TEXT);
  CREATE TABLE IF NOT EXISTS shrink_log (id TEXT PRIMARY KEY, item TEXT, reason TEXT, cost REAL, status TEXT, logged_by TEXT, time_logged TEXT);
  CREATE TABLE IF NOT EXISTS kill_dates (id TEXT PRIMARY KEY, item TEXT, item_code TEXT, kill_date TEXT, zone TEXT, status TEXT, logged_by TEXT, closed_by TEXT DEFAULT '', time_closed TEXT, quantity INTEGER NOT NULL DEFAULT 1);
  CREATE TABLE IF NOT EXISTS audit_ledger (id TEXT PRIMARY KEY, timestamp TEXT, user TEXT, action_type TEXT, target_table TEXT, details TEXT);
  CREATE TABLE IF NOT EXISTS auth_attempts (staff_name TEXT PRIMARY KEY, fail_count INTEGER DEFAULT 0, first_fail_at TEXT, locked_until TEXT);
  CREATE TABLE IF NOT EXISTS receiving_stats (id TEXT PRIMARY KEY, vendor TEXT, arrival_time TEXT, completion_time TEXT, duration_mins REAL, processed_by TEXT);
  CREATE TABLE IF NOT EXISTS receiving_vendor_aliases (
    alias_key TEXT PRIMARY KEY,
    alias_text TEXT NOT NULL,
    canonical_vendor TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    source TEXT NOT NULL DEFAULT 'seed',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_receiving_vendor_aliases_canonical ON receiving_vendor_aliases(canonical_vendor, active);
  CREATE TABLE IF NOT EXISTS staff_shifts (id TEXT PRIMARY KEY, staff_name TEXT NOT NULL, shift_date TEXT NOT NULL, start_time TEXT, end_time TEXT, role TEXT, department TEXT, notes TEXT, source_file TEXT, imported_at TEXT NOT NULL, imported_by TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS staff_name_aliases (
    source_name TEXT PRIMARY KEY,
    source_key TEXT NOT NULL UNIQUE,
    target_name TEXT DEFAULT '',
    alias_type TEXT NOT NULL DEFAULT 'alias',
    active INTEGER NOT NULL DEFAULT 1,
    notes TEXT DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS trusted_devices (id INTEGER PRIMARY KEY AUTOINCREMENT, ip_address TEXT UNIQUE, label TEXT, status TEXT DEFAULT 'Pending', last_seen TEXT, device_token_hash TEXT, token_created_at TEXT, last_seen_at TEXT);
  CREATE TABLE IF NOT EXISTS manager_audit_log (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT NOT NULL, actor_staff_id INTEGER, actor_name TEXT, action TEXT NOT NULL, target_type TEXT, target_id TEXT, summary TEXT, metadata_json TEXT, ip_address TEXT, user_agent TEXT);
  CREATE TABLE IF NOT EXISTS homebase_audits (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp DATETIME DEFAULT CURRENT_TIMESTAMP, zone_name TEXT, premium_name TEXT, audit_data TEXT, notes TEXT, auditor_id INTEGER, FOREIGN KEY(auditor_id) REFERENCES staff(id));
  CREATE TABLE IF NOT EXISTS shift_order_history (store_date TEXT PRIMARY KEY, order_start TEXT, order_end TEXT, recorded_at TEXT NOT NULL, grocery_pieces INTEGER DEFAULT 0, frozen_pieces INTEGER DEFAULT 0, hardware_pieces INTEGER DEFAULT 0, total_pieces INTEGER DEFAULT 0, staff_count INTEGER DEFAULT 1, standard_hours REAL DEFAULT 0, actual_order_minutes INTEGER DEFAULT 0, actual_pieces_per_hour REAL DEFAULT 0);
  CREATE TABLE IF NOT EXISTS daily_report_snapshots (
    store_date TEXT PRIMARY KEY,
    created_at TEXT NOT NULL,
    tasks_created INTEGER NOT NULL DEFAULT 0,
    tasks_closed INTEGER NOT NULL DEFAULT 0,
    tasks_open_end_of_day INTEGER NOT NULL DEFAULT 0,
    urgent_tasks_created INTEGER NOT NULL DEFAULT 0,
    urgent_tasks_closed INTEGER NOT NULL DEFAULT 0,
    oos_opened INTEGER NOT NULL DEFAULT 0,
    oos_closed INTEGER NOT NULL DEFAULT 0,
    oos_open_end_of_day INTEGER NOT NULL DEFAULT 0,
    outdated_item_logs INTEGER NOT NULL DEFAULT 0,
    outdated_item_value REAL NOT NULL DEFAULT 0,
    expiry_pull_logs INTEGER NOT NULL DEFAULT 0,
    expiry_due_count INTEGER NOT NULL DEFAULT 0,
    expected_orders_count INTEGER NOT NULL DEFAULT 0,
    received_orders_count INTEGER NOT NULL DEFAULT 0,
    special_orders_count INTEGER NOT NULL DEFAULT 0,
    order_pieces INTEGER NOT NULL DEFAULT 0,
    order_minutes INTEGER NOT NULL DEFAULT 0,
    order_staff_count INTEGER NOT NULL DEFAULT 0,
    team_pph REAL,
    adjusted_pph REAL,
    daily_direction_posted INTEGER NOT NULL DEFAULT 0,
    shift_updates_posted INTEGER NOT NULL DEFAULT 0,
    manager_on_duty TEXT,
    snapshot_json TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_daily_report_snapshots_date ON daily_report_snapshots(store_date DESC);

  CREATE TABLE IF NOT EXISTS safety_blurbs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1,
    sort_order INTEGER NOT NULL DEFAULT 0,
    last_used_date TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS daily_safety_focus (
    store_date TEXT PRIMARY KEY,
    blurb_id INTEGER,
    message TEXT NOT NULL,
    selected_at TEXT NOT NULL,
    selected_by TEXT,
    source TEXT NOT NULL DEFAULT 'auto'
  );
  CREATE INDEX IF NOT EXISTS idx_safety_blurbs_active_used ON safety_blurbs(active, last_used_date, sort_order, id);
  CREATE INDEX IF NOT EXISTS idx_daily_safety_focus_date ON daily_safety_focus(store_date DESC);
  CREATE INDEX IF NOT EXISTS idx_shift_order_recorded ON shift_order_history(recorded_at DESC);
  CREATE INDEX IF NOT EXISTS idx_staff_shifts_date ON staff_shifts(shift_date, start_time);
  CREATE INDEX IF NOT EXISTS idx_staff_name_aliases_type_active ON staff_name_aliases(alias_type, active);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_oos_status ON oos(status);
  CREATE INDEX IF NOT EXISTS idx_orders_status ON special_orders(status);
  CREATE INDEX IF NOT EXISTS idx_expected_status ON expected_orders(status);
  CREATE INDEX IF NOT EXISTS idx_kill_dates_status ON kill_dates(status);
  CREATE INDEX IF NOT EXISTS idx_shrink_status ON shrink_log(status);
  CREATE INDEX IF NOT EXISTS idx_audit_timestamp ON audit_ledger(timestamp);
  CREATE INDEX IF NOT EXISTS idx_tasks_time_closed ON tasks(time_closed);
  CREATE INDEX IF NOT EXISTS idx_homebase_audits_zone_time ON homebase_audits(zone_name, timestamp DESC);
  CREATE INDEX IF NOT EXISTS idx_manager_audit_created ON manager_audit_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_manager_audit_action ON manager_audit_log(action, created_at DESC);
`);

// Trusted device token columns + indexes are owned by migration 017
// (trusted_device_token_pairing). Do not re-ALTER at startup.

// Idempotent schema — numbered migrations in src/migrations/
const { runMigrations, getPendingMigrations } = require('./migrations/runner.cjs');
const { createPreMigrationSnapshot } = require('./lib/migration-safety.cjs');
const { getBackupsDir, getDataRoot } = require('./paths.cjs');
const { loadStoreTemplate, seedRhythmFromTemplate, applyZoneSettingsFromTemplate } = require('./lib/store-template.cjs');

runMigrations(db, {
  beforeApply(pending) {
    const snapshot = createPreMigrationSnapshot({
      db,
      dbPath,
      dataRoot: getDataRoot(),
      backupsDir: getBackupsDir(),
      pendingMigrations: pending || getPendingMigrations(db),
      failOnError: true,
    });
    if (snapshot.ok) {
      console.log(`[MIGRATION] pre-migration snapshot created: ${snapshot.file}`);
    } else if (!snapshot.skipped) {
      // Fail closed: never apply pending migrations without a verified snapshot.
      throw new Error(`MIGRATION_SNAPSHOT_REQUIRED: ${snapshot.error || snapshot.reason || 'unknown error'}`);
    }
  },
});

function initializeDailyRhythm() {
  const template = loadStoreTemplate('default');
  seedRhythmFromTemplate(db, template);
}

const { STORE_META_DEFAULTS, STORE_DISPLAY_NAME_KEY } = require('./constants/store-meta.cjs');
const { DEFAULT_FIFO_AISLE_ASSIGNMENTS, DEFAULT_ZONE_SECTION_LABELS, ensureStoreZoneDefaults } = require('./lib/store-zone-settings.cjs');
const { ensureTrainingStaff } = require('./lib/training-staff.cjs');
const { seedDefaultSafetyBlurbs } = require('./lib/safety-blurbs.cjs');
const { seedDefaultVendorAliases } = require('./lib/vendor-canonical.cjs');

function initializeSettings() {
  const defaults = [
    ...STORE_META_DEFAULTS,
    { name: 'TV_Scale', value: '1.0' },
    { name: 'TV_Task_Size', value: '100' },
    { name: 'Zone_Mapping', value: JSON.stringify({
      "Zone 1": ["map-a1", "map-a2", "map-a6"],
      "Zone 2": ["map-a3", "map-a4", "map-a5", "map-rfz"],
      "Zone 3": ["map-a7", "map-a8", "map-fsfrz"],
      "Zone 4": ["map-cmd"]
    }) },
    { name: 'Zone_Ownership', value: JSON.stringify({
      "Zone 1": "LUKE",
      "Zone 2": "ASHLEY",
      "Zone 3": "CHANDLER",
      "Zone 4": "CHRIS"
    }) },
    { name: 'Zone_Names', value: JSON.stringify({
      "Zone 1": "ZONE 1",
      "Zone 2": "ZONE 2",
      "Zone 3": "ZONE 3",
      "Zone 4": "ZONE 4"
    }) },
    { name: 'Zone_Section_Labels', value: JSON.stringify(DEFAULT_ZONE_SECTION_LABELS) },
    { name: 'FIFO_Aisle_Assignments', value: JSON.stringify(DEFAULT_FIFO_AISLE_ASSIGNMENTS) },
    { name: 'TV_Col_Split',  value: '2,1,1' },
    { name: 'TV_KPI_Size',   value: '1.0'   },
    { name: 'TV_Map_Size',   value: '1.0'   },
    { name: 'TV_Native_Shell', value: '1' },
    { name: 'TV_Show_Pinned_Daily_Huddle', value: '0' },
    { name: 'TV_Show_Store_Comms', value: '1' },
    { name: 'TV_Show_Audit_Trail', value: '1' },
    { name: 'TV_Show_Ticker', value: '0' },
    { name: 'TV_Show_Latest_Shift_Update', value: '0' },
    { name: 'Training_Mode_Enabled', value: '0' },
    { name: 'Unassigned_Option_Enabled', value: '1' },
    { name: 'Rhythm_Schedule_Edit_Enabled', value: '1' },
    { name: 'Betacs_Enabled', value: '0' },
    { name: 'Cs_Full_Enabled', value: '0' },
    { name: 'Cs_Hub_Enabled', value: '0' },
    { name: 'Cs_Crm_Enabled', value: '0' },
    { name: 'Task_Work_Timing_Enabled', value: '0' },
    { name: 'Store_Open_Hour', value: '7' },
    { name: 'Store_Close_Weekday', value: '20' },
    { name: 'Store_Close_Sunday', value: '18' },
    { name: 'Message_Center_Enabled', value: '1' },
    { name: 'Comms_System_Messages', value: '1' },
    { name: 'Inventory_Count_Enabled', value: '0' },
    { name: 'Allow_LAN_Clients', value: '1' },
    { name: 'LAN_Bind_Host', value: '0.0.0.0' },
    { name: 'LAN_Port', value: '3001' },
    { name: 'Require_TV_Device_Token', value: '1' },
    { name: 'Operational_Retention_Days', value: '365' },
    { name: 'Report_Trend_Window_Days', value: '90' },
  ];
  db.transaction(() => {
    defaults.forEach(d => {
      db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES (?, ?)", d.name, d.value);
    });
  })();
  // Branding repair: preserve custom names, but migrate the accidental old default.
  db.run(
    "UPDATE settings SET setting_value = ? WHERE setting_name = ? AND setting_value = ?",
    'TGP Center Store',
    STORE_DISPLAY_NAME_KEY,
    'TGP Command Center',
  );
  applyZoneSettingsFromTemplate(db, loadStoreTemplate('default'), { overwrite: false });
  ensureStoreZoneDefaults(db);
  ensureTrainingStaff(db);
  seedDefaultSafetyBlurbs(db);
  seedDefaultVendorAliases(db);
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Betacs_Enabled', '0')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Task_Work_Timing_Enabled', '0')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Rhythm_Schedule_Edit_Enabled', '1')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Allow_LAN_Clients', '1')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('LAN_Bind_Host', '0.0.0.0')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('LAN_Port', '3001')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Require_TV_Device_Token', '1')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('TV_Show_Pinned_Daily_Huddle', '0')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('TV_Show_Store_Comms', '1')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('TV_Show_Audit_Trail', '1')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('TV_Show_Ticker', '0')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('TV_Show_Latest_Shift_Update', '0')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Operational_Retention_Days', '365')");
  db.run("INSERT OR IGNORE INTO settings (setting_name, setting_value) VALUES ('Report_Trend_Window_Days', '90')");
  try {
    const { ensureStoreInstanceId } = require('./lib/store-instance-id.cjs');
    ensureStoreInstanceId(db);
  } catch (e) {
    console.warn('[SETTINGS] Store_Instance_Id ensure failed:', e.message || e);
  }
}

module.exports = { db, dbConn, initializeDailyRhythm, initializeSettings };
