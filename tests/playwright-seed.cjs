'use strict';

/**
 * Run with Electron as Node so better-sqlite3 matches NODE_MODULE_VERSION:
 *   ELECTRON_RUN_AS_NODE=1 path/to/electron.exe tests/playwright-seed.cjs
 */
const fs = require('fs');
const path = require('path');

const STAFF_NAME = 'Playwright E2E';
const STAFF_PIN = 'pw-e2e-9f2a1c';
const CACHE_NAME = '.playwright-staff-cache.json';
const MANAGER_A = { name: 'Playwright Manager A', pin: 'pw-manager-a-510', role: 'Manager' };
const MANAGER_B = { name: 'Playwright Manager B', pin: 'pw-manager-b-510', role: 'Manager' };
const STORE_MANAGER = { name: 'Playwright Store Manager', pin: 'pw-store-manager-511', role: 'Store Manager' };
const PERIOD_START = '2026-06-01';
const SECURITY_PII = {
    orderId: 'PW-SEC-ORDER-9911',
    customer: 'PWSEC-CUSTOMER-ZEBRA-9911',
    contact: '780-555-0199-PWSEC',
    notes: 'PWSEC-NOTES-MAGENTA-ONLY',
    item: '1X PWSEC-TV-WIDGET',
};
const IP_ONLY_TV = {
    address: '192.168.99.99',
    label: 'Playwright IP-only TV',
};

const { db, dbConn, initializeSettings, initializeDailyRhythm } = require(path.join(__dirname, '../src/db.cjs'));

let exitCode = 1;
try {
    dbConn.pragma('busy_timeout = 8000');
    initializeSettings();
    initializeDailyRhythm();
    const { runMigrations } = require(path.join(__dirname, '../src/migrations/runner.cjs'));
    runMigrations(db);
    const {
        issueDeviceTokenForDevice,
    } = require(path.join(__dirname, '../src/lib/trusted-device-tokens.cjs'));

    db.run(`
        INSERT OR IGNORE INTO staff (name, active, pin, app_access, role, pin_hashed)
        VALUES (?, 1, ?, 1, 'Clerk', 0)
    `, STAFF_NAME, STAFF_PIN);
    db.run(`
        UPDATE staff SET active = 1, app_access = 1, pin = ?, pin_hashed = 0 WHERE name = ?
    `, STAFF_PIN, STAFF_NAME);
    db.run('DELETE FROM auth_attempts WHERE staff_name = ?', STAFF_NAME);

    db.run(
        `INSERT INTO trusted_devices (ip_address, label, status, device_purpose)
         VALUES ('fixture://cs-desk', 'Playwright CS Desk', 'Pending', 'cs_desk')
         ON CONFLICT(ip_address) DO UPDATE SET
            label=excluded.label, device_purpose='cs_desk'`,
    );
    const csDevice = db.get(
        "SELECT id FROM trusted_devices WHERE ip_address='fixture://cs-desk'",
    );
    const csDeviceToken = issueDeviceTokenForDevice(db, csDevice.id, {
        label: 'Playwright CS Desk',
        purpose: 'cs_desk',
    }).deviceToken;

    // Authorized TV with purpose but no token — proves IP/status alone is not enough.
    db.run(
        `INSERT INTO trusted_devices (ip_address, label, status, device_purpose, device_token_hash)
         VALUES (?, ?, 'Authorized', 'tv', NULL)
         ON CONFLICT(ip_address) DO UPDATE SET
            label=excluded.label,
            status='Authorized',
            device_purpose='tv',
            device_token_hash=NULL`,
        IP_ONLY_TV.address,
        IP_ONLY_TV.label,
    );

    // Unmistakable test-only customer PII for TV sync redaction assertions.
    db.run('DELETE FROM special_orders WHERE order_id = ?', SECURITY_PII.orderId);
    db.run(
        `INSERT INTO special_orders (
            order_id, customer, item, contact, location, status, logged_by, time_logged,
            route, needed_by, source, taken_by, notes
         ) VALUES (?, ?, ?, ?, '1', 'Open', 'PW-SEC-SEED', datetime('now'), 'Pop', '2099-01-01', 'legacy', 'PW-SEC-TAKER', ?)`,
        SECURITY_PII.orderId,
        SECURITY_PII.customer,
        SECURITY_PII.item,
        SECURITY_PII.contact,
        SECURITY_PII.notes,
    );

    const { TRAINING_STAFF_NAME, ensureTrainingStaff } = require(path.join(__dirname, '../src/lib/training-staff.cjs'));
    ensureTrainingStaff(db);
    db.run('DELETE FROM auth_attempts WHERE staff_name = ?', TRAINING_STAFF_NAME);

    for (const manager of [MANAGER_A, MANAGER_B, STORE_MANAGER]) {
        db.run(
            `INSERT INTO staff (name, active, pin, app_access, role, pin_hashed, permissions)
             VALUES (?, 1, ?, 1, ?, 0, 'receiving')
             ON CONFLICT(name) DO UPDATE SET
                active=1, pin=excluded.pin, app_access=1, role=excluded.role,
                pin_hashed=0, permissions='receiving'`,
            manager.name,
            manager.pin,
            manager.role,
        );
        db.run('DELETE FROM auth_attempts WHERE staff_name=?', manager.name);
    }

    db.run(
        `INSERT INTO settings (setting_name, setting_value) VALUES
            ('Financial_Log_Shadow_Mode', '0'),
            ('Receiving_Report_Period_Start', ?)
         ON CONFLICT(setting_name) DO UPDATE SET setting_value=excluded.setting_value`,
        PERIOD_START,
    );

    // Deterministic, throwaway 5.4.11 workflow fixture. This data directory is isolated
    // by playwright.config.cjs and never points at store data.
    db.run('DELETE FROM receiving_report_period_status WHERE period_start=?', PERIOD_START);
    db.run("DELETE FROM receiving_report_lines WHERE store_date BETWEEN ? AND date(?, '+34 days')", PERIOD_START, PERIOD_START);
    db.run("DELETE FROM receiving_report_day WHERE store_date BETWEEN ? AND date(?, '+34 days')", PERIOD_START, PERIOD_START);
    db.run('DELETE FROM receiving_report_sales WHERE period_start=?', PERIOD_START);
    db.run('DELETE FROM receiving_report_sales_zero_confirm WHERE period_start=?', PERIOD_START);
    db.run('DELETE FROM receiving_report_margin WHERE period_start=?', PERIOD_START);

    const {
        saveLine,
        upsertDayMeta,
        saveDayCertification,
    } = require(path.join(__dirname, '../src/lib/edmonton-receiving-report.cjs'));
    const {
        saveSalesAmount,
        saveSalesZeroConfirm,
        saveMarginMeta,
    } = require(path.join(__dirname, '../src/lib/edmonton-receiving-analytics.cjs'));
    saveLine(db, '2026-06-02', {
        supplier_name: 'SMS',
        invoice_number: 'ITEM-X',
        grocery: 32.03,
        freight_grocery: 0.46,
    }, MANAGER_A.name);
    upsertDayMeta(db, '2026-06-02', {
        receiver_name: 'Receiver E2E',
        freight_total: 0.46,
    }, MANAGER_A.name);
    saveDayCertification(db, '2026-06-02', {
        receiving_complete: true,
        invoices_entered: true,
        references_verified: true,
        freight_verified: true,
        receiver_identified: true,
        exceptions_documented: true,
    }, MANAGER_A.name);
    for (let week = 1; week <= 5; week += 1) {
        saveSalesAmount(db, PERIOD_START, week, 'grocery', 1000, MANAGER_A.name);
        saveSalesAmount(db, PERIOD_START, week, 'dairy', 200, MANAGER_A.name);
        saveSalesAmount(db, PERIOD_START, week, 'produce', 150, MANAGER_A.name);
        saveSalesZeroConfirm(
            db,
            PERIOD_START,
            '__week__',
            week,
            MANAGER_A.name,
            'E2E fixture confirms remaining categories are zero',
        );
    }
    saveMarginMeta(db, PERIOD_START, {
        opening_inventory: 10000,
        closing_inventory: 9000,
    }, MANAGER_A.name);

    const cachePath = path.join(__dirname, CACHE_NAME);
    fs.writeFileSync(cachePath, JSON.stringify({
        name: STAFF_NAME,
        pin: STAFF_PIN,
        managerA: MANAGER_A,
        managerB: MANAGER_B,
        storeManager: STORE_MANAGER,
        periodStart: PERIOD_START,
        csDeviceToken,
        securityPii: SECURITY_PII,
        ipOnlyTvLabel: IP_ONLY_TV.label,
        ipOnlyTvAddress: IP_ONLY_TV.address,
    }, null, 0), 'utf8');
    console.log('[playwright-seed] OK', STAFF_NAME);
    exitCode = 0;
} catch (e) {
    console.error('[playwright-seed]', e.message);
} finally {
    try { dbConn.close(); } catch (_) { /* ignore */ }
}
process.exit(exitCode);
