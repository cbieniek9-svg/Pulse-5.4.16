'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const {
    assembleSyncPayload,
    resolveSyncAudience,
    redactSettingsForAudience,
    publicStaffRow,
    buildOrderPayloadForAudience,
    authorizeTvSyncRequest,
} = require('../src/dal/sync-payload.cjs');
const { createStaffHandlers } = require('../src/actions/handlers/staff.cjs');
const { hasStaffPermission, isManagerRole } = require('../src/lib/staff-permissions.cjs');
const { createDeviceToken, hashDeviceToken } = require('../src/lib/trusted-device-tokens.cjs');

test('resolveSyncAudience separates public, TV, staff, and manager clients', () => {
    assert.equal(resolveSyncAudience(null), 'public');
    assert.equal(resolveSyncAudience({ role: 'TV' }), 'tv');
    assert.equal(resolveSyncAudience({ role: 'Clerk' }), 'staff');
    assert.equal(resolveSyncAudience({ role: 'Premium Clerk' }), 'staff');
    assert.equal(resolveSyncAudience({ role: 'Manager' }), 'manager');
    assert.equal(resolveSyncAudience({ role: 'manager' }), 'manager');
    assert.equal(resolveSyncAudience({ role: '  sToRe   MANAGER ' }), 'manager');
    assert.equal(isManagerRole(' manager '), true);
    assert.equal(isManagerRole('  sToRe   MANAGER '), true);
    assert.equal(hasStaffPermission({}, { role: ' MANAGER ' }, 'safe'), true);
});

test('redactSettingsForAudience only gives sensitive settings to managers', () => {
    const settings = {
        Store_Display_Name: 'Demo Store',
        TV_ACCESS_KEY: 'secret-tv',
        Presence_Gateway_Key: 'secret-gw',
        Presence_Staff_Beacons: '{"badge":"staff"}',
    };

    const manager = redactSettingsForAudience(settings, 'manager');
    assert.equal(manager.TV_ACCESS_KEY, 'secret-tv');

    assert.deepEqual(redactSettingsForAudience(settings, 'public'), {});

    for (const audience of ['tv', 'staff']) {
        const safe = redactSettingsForAudience(settings, audience);
        assert.equal(safe.Store_Display_Name, 'Demo Store');
        assert.equal(Object.hasOwn(safe, 'TV_ACCESS_KEY'), false);
        assert.equal(Object.hasOwn(safe, 'Presence_Gateway_Key'), false);
        assert.equal(Object.hasOwn(safe, 'Presence_Staff_Beacons'), false);
    }
});

test('publicStaffRow limits fields used before login and by TV displays', () => {
    assert.deepEqual(
        publicStaffRow({ id: 7, name: 'SAM', active: 1, app_access: 1, pin: '1234', permissions: 'manager' }),
        { name: 'SAM' },
    );
});

test('public sync exposes only a minimal non-manager login roster and empty bootstrap shells', () => {
    const staff = [
        { id: 1, name: 'Clerk', active: 1, app_access: 1, role: 'Clerk', permissions: 'tasks' },
        { id: 2, name: 'Manager', active: 1, app_access: 1, role: 'Manager', permissions: 'admin' },
        { id: 3, name: 'Store Manager', active: 1, app_access: 1, role: 'Store Manager', permissions: 'admin' },
        { id: 4, name: 'TRAINING MODE', active: 1, app_access: 1, role: 'Clerk', permissions: 'tasks' },
        { id: 5, name: 'Inactive Clerk', active: 0, app_access: 1, role: 'Clerk', permissions: 'tasks' },
        { id: 6, name: 'No App Access', active: 1, app_access: 0, role: 'Clerk', permissions: 'tasks' },
        { id: 7, name: 'Lower Manager', active: 1, app_access: 1, role: 'manager', permissions: '' },
        { id: 8, name: 'Mixed Store Manager', active: 1, app_access: 1, role: '  sToRe   MANAGER ', permissions: '' },
    ];
    const settings = {
        Training_Mode_Enabled: '1',
        Require_TV_Device_Token: '1',
        Store_Timezone: 'America/Edmonton',
    };
    const db = {
        getSettings: () => ({ ...settings }),
        getCounts: () => ({ grocery: 12, frozen: 4, hardware: 3, staff: 2 }),
        get(sql, key) {
            if (sql.includes('setting_name = ?') || sql.includes('setting_name=?')) {
                return { setting_value: settings[key] };
            }
            if (sql.includes('SUM(')) return { t: 0 };
            return undefined;
        },
        all(sql) {
            if (sql.includes('PRAGMA table_info(staff)')) return [];
            if (sql.includes('FROM staff ORDER BY name')) return staff;
            return [];
        },
        run() {},
    };
    const auth = {
        getSession: () => null,
        listActiveSessions: () => [],
    };
    const req = { header: () => '' };

    const payload = assembleSyncPayload({
        db,
        auth,
        req,
        APP_VERSION: '5.4.12',
        getStoreDateStamp: () => '2026-08-03',
        getStoreClockPayload: () => ({
            storeWeekday: 'MONDAY',
            storeDateLabel: 'August 3',
            storeTime: '23:15',
            storeTimeSeconds: 83700,
            storeTimezone: 'America/Edmonton',
        }),
        cachedHeatMap: { operational: true },
    });

    assert.deepEqual(payload.staff, [{ name: 'Clerk' }]);
    assert.equal(Object.hasOwn(payload, 'trainingProfile'), false);
    assert.equal(payload.features.trainingMode, false);
    assert.deepEqual(payload.tasks, []);
    assert.deepEqual(payload.orders, []);
    assert.deepEqual(payload.orders_tv, []);
    assert.equal(Object.hasOwn(payload, 'devices'), false);
    assert.equal(Object.hasOwn(payload, 'deviceAuth'), false);
    assert.equal(JSON.stringify(payload).includes('TRAINING MODE'), false);
    assert.equal(JSON.stringify(payload).includes('1234'), false);
    assert.equal(Object.hasOwn(payload.staff[0], 'role'), false);
    assert.equal(Object.hasOwn(payload.staff[0], 'permissions'), false);
});

test('TV order payload omits mobile orders and allowlists exact display fields', () => {
    const unmistakable = {
        order_id: 'ORDER-TV-SECRET',
        location: 'A3',
        item: 'TEST WIDGET',
        status: 'Ordered',
        source: 'betacs',
        customer: 'CUSTOMER SECRET ZEBRA',
        contact: '780-555-0199',
        customer_id: 'CUSTOMER-ID-SECRET',
        notes: 'NOTES SECRET MAGENTA',
        logged_by: 'PRIVATE LOGGER',
        taken_by: 'PRIVATE TAKER',
        route: 'PRIVATE ROUTE',
        needed_by: '2099-01-01',
    };
    const db = {
        getSettings: () => ({ CS_Full_Enabled: '0' }),
        all: () => [{ ...unmistakable }],
    };

    const payload = buildOrderPayloadForAudience(db, 'tv');
    assert.equal(Object.hasOwn(payload, 'orders'), false);
    assert.deepEqual(Object.keys(payload.orders_tv[0]).sort(), [
        'item', 'location', 'order_id', 'source', 'status',
    ]);
    const serialized = JSON.stringify(payload);
    for (const secret of [
        unmistakable.customer,
        unmistakable.contact,
        unmistakable.customer_id,
        unmistakable.notes,
        unmistakable.logged_by,
        unmistakable.taken_by,
        unmistakable.route,
        unmistakable.needed_by,
    ]) {
        assert.equal(serialized.includes(secret), false, secret);
    }
});

test('TV sync promotion requires a current token with tv purpose and never IP', () => {
    const token = createDeviceToken();
    const row = {
        id: 44,
        ip_address: '192.168.1.44',
        label: 'Secure TV',
        status: 'Authorized',
        device_purpose: 'tv',
        device_token_hash: hashDeviceToken(token),
    };
    const db = {
        get(sql, value) {
            if (sql.includes('device_token_hash=?')
                && value === row.device_token_hash
                && row.status === 'Authorized') return { ...row };
            return null;
        },
        run() { return { changes: 1 }; },
        exec() {},
    };
    const request = (presented) => ({
        headers: presented ? { 'x-device-token': presented } : {},
        ip: row.ip_address,
        body: {},
    });

    const valid = authorizeTvSyncRequest(db, request(token));
    assert.equal(valid.authorized, true);
    assert.equal(resolveSyncAudience({ role: valid.authorized ? 'TV' : '' }), 'tv');

    row.device_purpose = 'receiving';
    assert.equal(authorizeTvSyncRequest(db, request(token)).reason, 'wrong_purpose');
    row.device_purpose = 'tv';
    row.status = 'Revoked';
    assert.equal(authorizeTvSyncRequest(db, request(token)).authorized, false);
    row.status = 'Authorized';
    assert.equal(authorizeTvSyncRequest(db, request()).reason, 'missing_token');
    assert.equal(authorizeTvSyncRequest(db, request()).authorized, false);
});

test('assembled TV sync is promoted only by tv token and has no full orders property', () => {
    const token = createDeviceToken();
    const tokenHash = hashDeviceToken(token);
    const device = {
        id: 55,
        ip_address: '192.168.1.55',
        label: 'TV Integration',
        status: 'Authorized',
        device_purpose: 'tv',
        device_token_hash: tokenHash,
    };
    const sensitiveOrder = {
        order_id: 'TV-INTEGRATION-ORDER',
        location: 'A5',
        item: 'Display item',
        status: 'Open',
        source: 'legacy',
        customer: 'INTEGRATION CUSTOMER SECRET',
        contact: '780-555-0101',
        notes: 'INTEGRATION NOTES SECRET',
    };
    const settings = {
        Require_TV_Device_Token: '1',
        Store_Timezone: 'America/Edmonton',
        Store_Display_Name: 'Safe TV Store',
        TV_Scale: '1.1',
        Zone_Mapping: '{"Zone 1":["A1"]}',
        TV_ACCESS_KEY: 'TV-KEY-NEVER-SERIALIZE',
        Presence_Gateway_Key: 'PRESENCE-SECRET-NEVER-SERIALIZE',
        Manager_Only_Secret: 'MANAGER-SECRET-NEVER-SERIALIZE',
        Cs_Full_Enabled: '0',
        Message_Center_Enabled: '0',
        Presence_Enabled: '0',
    };
    const queries = [];
    const db = {
        getSettings: () => ({ ...settings }),
        getCounts: () => ({ grocery: 0, frozen: 0, hardware: 0, staff: 1 }),
        get(sql, value) {
            queries.push(sql);
            if (sql.includes('device_token_hash=?')
                && value === tokenHash
                && device.status === 'Authorized') return { ...device };
            if (sql.includes('FROM safety_blurbs')) {
                return { id: 1, message: 'Test safety focus', active: 1 };
            }
            if (sql.includes('setting_name')) return settings[value] === undefined
                ? undefined
                : { setting_value: settings[value] };
            if (sql.includes('SUM(')) return { t: 0 };
            return undefined;
        },
        all(sql) {
            queries.push(sql);
            if (sql.includes('FROM special_orders')) return [{ ...sensitiveOrder }];
            if (sql.includes("FROM tasks WHERE status='Open'")) {
                return [{
                    task_id: 'TASK-TV-1',
                    task_detail: 'Face aisle A1',
                    status: 'Open',
                    priority: 'High',
                    zone: 'A1',
                    assigned_to: 'Clerk',
                    submitted_by_phone: '780-555-SECRET',
                    manager_notes: 'PRIVATE MANAGER TASK NOTE',
                }];
            }
            if (sql.includes('FROM kill_dates') && sql.includes('days_until')) {
                return [{
                    id: 91,
                    item: 'Expiry item',
                    zone: 'A1',
                    kill_date: '2026-08-05',
                    days_until: 1,
                    private_supplier_note: 'PRIVATE EXPIRY NOTE',
                }];
            }
            if (sql.includes('FROM kill_dates')) {
                return [{
                    id: 91,
                    item: 'Expiry item',
                    zone: 'A1',
                    kill_date: '2026-08-05',
                    private_supplier_note: 'PRIVATE EXPIRY NOTE',
                }];
            }
            return [];
        },
        run() { return { changes: 1 }; },
        exec() {},
    };
    const auth = { getSession: () => null, listActiveSessions: () => [] };
    const makePayload = (presentedToken) => assembleSyncPayload({
        db,
        auth,
        req: {
            header: (name) => name === 'x-device-token' ? presentedToken : '',
            headers: presentedToken ? { 'x-device-token': presentedToken } : {},
            ip: device.ip_address,
            body: {},
        },
        APP_VERSION: '5.4.12',
        getStoreDateStamp: () => '2026-08-04',
        getStoreClockPayload: () => ({
            storeWeekday: 'TUESDAY',
            storeDateLabel: 'August 4',
            storeTime: '09:00',
            storeTimeSeconds: 32400,
            storeTimezone: 'America/Edmonton',
        }),
        cachedHeatMap: {},
    });

    const tv = makePayload(token);
    assert.equal(tv.syncAudience, 'tv');
    assert.equal(Object.hasOwn(tv, 'orders'), false);
    assert.deepEqual(Object.keys(tv.orders_tv[0]).sort(), [
        'item', 'location', 'order_id', 'source', 'status',
    ]);
    assert.deepEqual(Object.keys(tv).sort(), [
        'appVersion',
        'comms',
        'daily_direction_floor',
        'daily_safety_focus',
        'deviceSessionActive',
        'kill_dates',
        'kill_warnings',
        'kpis',
        'orders_tv',
        'presence_tv',
        'settings',
        'store',
        'storeDate',
        'storeDateLabel',
        'storeTime',
        'storeTimezone',
        'storeWeekday',
        'syncAudience',
        'tasks',
        'ticker',
        'tv_display',
    ].sort());
    assert.deepEqual(Object.keys(tv.tasks[0]).sort(), [
        'assigned_to', 'priority', 'status', 'task_detail', 'task_id', 'zone',
    ]);
    assert.deepEqual(Object.keys(tv.kpis).sort(), [
        'f',
        'g',
        'h',
        'order_staff',
        'shift_active',
        'shift_done',
        'shift_pph',
        'shift_pph_final',
        'shift_standard_pph',
        'shift_total_pieces',
        'staff',
    ].sort());
    assert.deepEqual(Object.keys(tv.kill_dates[0]).sort(), [
        'id', 'item', 'kill_date', 'zone',
    ]);
    assert.deepEqual(Object.keys(tv.kill_warnings[0]).sort(), [
        'days_until', 'id', 'item', 'kill_date', 'zone',
    ]);
    assert.deepEqual(Object.keys(tv.settings).sort(), [
        'FIFO_Aisle_Assignments',
        'Hardware_Arrived',
        'Order_Start',
        'Safety_Message',
        'Store_Display_Name',
        'TV_Col_Split',
        'TV_KPI_Size',
        'TV_Map_Size',
        'TV_Safety_Message',
        'TV_Scale',
        'Zone_Mapping',
        'Zone_Names',
        'Zone_Ownership',
        'Zone_Section_Labels',
    ].sort());
    assert.equal(JSON.stringify(tv).includes(sensitiveOrder.customer), false);
    assert.equal(JSON.stringify(tv).includes(sensitiveOrder.contact), false);
    assert.equal(JSON.stringify(tv).includes(sensitiveOrder.notes), false);
    assert.equal(JSON.stringify(tv).includes('780-555-SECRET'), false);
    assert.equal(JSON.stringify(tv).includes('PRIVATE MANAGER TASK NOTE'), false);
    assert.equal(JSON.stringify(tv).includes('PRIVATE EXPIRY NOTE'), false);
    assert.equal(JSON.stringify(tv).includes('TV-KEY-NEVER-SERIALIZE'), false);
    assert.equal(JSON.stringify(tv).includes('PRESENCE-SECRET-NEVER-SERIALIZE'), false);
    assert.equal(JSON.stringify(tv).includes('MANAGER-SECRET-NEVER-SERIALIZE'), false);
    assert.equal(queries.some((sql) => /FROM shrink_log/i.test(sql)), false);
    assert.equal(queries.some((sql) => /FROM expected_orders/i.test(sql)), false);
    for (const excluded of [
        'expected',
        'hardware_orders',
        'shrink',
        'rhythm_tasks',
        'vendor_schedule',
        'zoneHeatMap',
        'staff',
        'devices',
        'health',
        'manager_meta',
    ]) {
        assert.equal(Object.hasOwn(tv, excluded), false, excluded);
    }

    device.device_purpose = 'receiving';
    const wrongPurpose = makePayload(token);
    assert.equal(wrongPurpose.syncAudience, 'public');
    assert.deepEqual(wrongPurpose.orders, []);
    assert.deepEqual(wrongPurpose.orders_tv, []);
});

test('staff and manager order payloads retain mobile orders', () => {
    const mobile = [{ order_id: 'MOBILE-ORDER', customer: 'Allowed for staff' }];
    const tv = [{ order_id: 'TV-ORDER', location: 'A1', item: 'Widget', status: 'Ordered', source: 'legacy' }];
    const db = {
        getSettings: () => ({ CS_Full_Enabled: '0' }),
        all(sql) {
            return /SELECT\s+\*/i.test(sql) ? mobile : tv;
        },
    };
    for (const audience of ['staff', 'manager']) {
        const payload = buildOrderPayloadForAudience(db, audience);
        assert.deepEqual(payload.orders, mobile);
        assert.deepEqual(payload.orders_tv, tv);
    }
});

test('TV client consumes orders_tv only and clears stale operational data on auth failure', async () => {
    const source = fs.readFileSync(
        path.join(__dirname, '../public/tv/tv-dashboard.js'),
        'utf8',
    );
    assert.doesNotMatch(source, /data\.orders_tv\s*\?\s*data\.orders_tv\s*:\s*\(data\.orders/);
    assert.match(source, /Array\.isArray\(data\.orders_tv\)\s*\?\s*data\.orders_tv\s*:\s*\[\]/);
    assert.match(source, /showPairingRequired/);
    assert.match(source, /if\s*\(!deviceToken\)/);
    assert.match(source, /data\?\.syncAudience\s*!==\s*['"]tv['"]/);

    const elements = new Map([
        ['tv-store-title', { textContent: 'STALE STORE', innerHTML: 'STALE STORE', style: {} }],
        ['tv-kpis', { innerHTML: 'SECRET KPI', style: {} }],
        ['tv-col-center', { innerHTML: 'SECRET TASK', style: {} }],
        ['tv-col-right-secondary', { innerHTML: 'SECRET CUSTOMER', style: {} }],
        ['tv-map-svg', { innerHTML: 'SECRET MAP', style: {} }],
        ['tv-ticker', { innerHTML: 'SECRET TICKER', style: {} }],
        ['tv-ticker-wrap', { innerHTML: '', style: { display: 'block' } }],
    ]);
    const sandbox = {
        URL,
        URLSearchParams,
        Date,
        Math,
        CustomEvent: class CustomEvent {},
        console: { error() {}, warn() {}, log() {} },
        document: {
            title: 'TV',
            body: { dataset: {} },
            getElementById: (id) => elements.get(id) || null,
            querySelector: () => null,
            createElement: () => ({ classList: { add() {}, remove() {} } }),
        },
        fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
        setInterval: () => 0,
        setTimeout: () => 0,
        clearTimeout() {},
        window: {
            location: { href: 'http://store.local/tv' },
            localStorage: {
                getItem: () => 'revoked-tv-token',
                setItem() {},
            },
            history: { replaceState() {} },
            addEventListener() {},
            dispatchEvent() {},
        },
    };
    vm.runInNewContext(source, sandbox);
    await sandbox.window.TgpTvNative.refresh();

    assert.equal(elements.get('tv-store-title').textContent, 'PAIRING REQUIRED');
    assert.equal(elements.get('tv-kpis').innerHTML, '');
    assert.equal(elements.get('tv-col-right-secondary').innerHTML, '');
    assert.equal(elements.get('tv-map-svg').innerHTML, '');
    assert.match(elements.get('tv-col-center').innerHTML, /pairing required/i);
    assert.equal(elements.get('tv-ticker-wrap').style.display, 'none');
});

test('floor login offers explicit name entry and submits that typed name', () => {
    const floorSource = fs.readFileSync(
        path.join(__dirname, '../client/src/components/floor/AuthScreen.jsx'),
        'utf8',
    );
    const portalSource = fs.readFileSync(
        path.join(__dirname, '../client/src/components/shared/PortalAuth.jsx'),
        'utf8',
    );
    const apiSource = fs.readFileSync(
        path.join(__dirname, '../client/src/lib/api.js'),
        'utf8',
    );

    for (const source of [floorSource, portalSource]) {
        assert.match(source, /type=["']button["'][\s\S]*Enter name manually/i);
        assert.match(source, /aria-label=["']Enter your name["']/);
        assert.match(source, /await login\(name,\s*pin\)/);
        assert.match(source, /role=["']alert["']/);
        assert.match(source, /\.focus\(\)/);
    }
    assert.doesNotMatch(`${floorSource}\n${apiSource}`, /TRAINING MODE|trainingProfile|demo PIN/i);
});

test('production UI and legacy runtime contain no training account privileges or hints', () => {
    const productionFiles = [
        '../client/src/settings/tabs/StaffTab.jsx',
        '../client/src/settings/lib/settingsHelpers.js',
        '../client/src/lib/floorUtils.js',
        '../client/src/components/floor/ManagerBanner.jsx',
        '../client/src/hooks/useFloorRole.js',
        '../public/js/mobile/auth.js',
        '../public/js/mobile/core.js',
        '../public/js/tgp-api.js',
        '../client/src/reports/engine/bundled.js',
    ];
    const source = productionFiles
        .map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8'))
        .join('\n');

    assert.doesNotMatch(
        source,
        /TRAINING MODE|trainingProfile|demo PIN|Training_Mode_Enabled|isTrainingUser/i,
    );
});

test('staff actions cannot reactivate the revoked legacy account', () => {
    let updated = false;
    const handlers = createStaffHandlers({
        db: {
            get: () => ({ name: 'TRAINING MODE' }),
        },
        broadcastUpdate() {},
        actionHandlers: {
            generic_update() { updated = true; },
        },
    });

    assert.throws(
        () => handlers.staff_update({
            id_val: 4,
            workingData: { active: 1, app_access: 1, pin: '9999', role: 'Manager' },
        }),
        /revoked/i,
    );
    assert.throws(
        () => handlers.staff_insert({
            workingData: { name: ' training mode ', active: 1, app_access: 1, pin: '9999', role: 'Manager' },
        }),
        /revoked|reserved/i,
    );
    assert.equal(updated, false);

    const renameHandlers = createStaffHandlers({
        db: {
            get: () => ({ name: 'Ordinary Clerk' }),
        },
        broadcastUpdate() {},
        actionHandlers: {
            generic_update() { updated = true; },
        },
    });
    assert.throws(
        () => renameHandlers.staff_update({
            id_val: 9,
            workingData: { name: '  training mode  ' },
        }),
        /revoked|reserved/i,
    );
    assert.equal(updated, false);
});

test('client manager-role helper matches canonical server semantics', async () => {
    const { isManagerRole: isClientManagerRole } = await import('../client/src/lib/roles.js');
    for (const role of ['Manager', ' manager ', '  sToRe   MANAGER ']) {
        assert.equal(isClientManagerRole(role), true, role);
    }
    assert.equal(isClientManagerRole('Premium Clerk'), false);
});

test('shipped legacy login can submit an explicitly typed hidden manager name', async () => {
    const elements = new Map();
    let activeElement = null;
    let submitted = null;
    let finishRequest;

    class FakeElement {
        constructor(tag = 'div', id = '') {
            this.tagName = tag.toUpperCase();
            this._id = '';
            this.id = id;
            this.style = {};
            this.children = [];
            this.value = '';
            this.textContent = '';
            this.disabled = false;
            this.classList = { add() {} };
        }
        get id() { return this._id; }
        set id(value) {
            this._id = value;
            if (value) elements.set(value, this);
        }
        appendChild(child) {
            this.children.push(child);
            if (child.id) elements.set(child.id, child);
        }
        after(child) {
            if (child.id) elements.set(child.id, child);
        }
        focus() { activeElement = this; }
        set innerHTML(_) { this.children = []; }
    }

    for (const id of ['auth-user', 'auth-pin', 'app-version-label']) {
        elements.set(id, new FakeElement(id === 'auth-user' ? 'select' : 'input', id));
    }
    const submit = new FakeElement('button');
    submit.className = 'st-btn';
    submit.textContent = 'UNLOCK UPLINK';
    elements.get('auth-pin').value = '2468';

    const context = {
        API_BASE: '',
        TgpApi: { filterLoginStaff: (data) => data.staff },
        fetch: async () => ({
            ok: true,
            json: async () => ({ appVersion: '5.4.12', staff: [{ name: 'Clerk' }] }),
        }),
        postJson: async (_url, body) => {
            submitted = body;
            return new Promise((resolve) => { finishRequest = resolve; });
        },
        showNotice() {},
        setTimeout() {},
        console,
        sessionStorage: { setItem() {} },
        localStorage: { setItem() {}, removeItem() {} },
        location: { reload() {} },
        document: {
            createElement: (tag) => new FakeElement(tag),
            querySelector: (selector) => selector === '#auth-screen .st-btn' ? submit : null,
        },
        $el: (id) => elements.get(id) || null,
    };
    vm.runInNewContext(
        fs.readFileSync(path.join(__dirname, '../public/js/mobile/auth.js'), 'utf8'),
        context,
    );

    await context.fetchLoginStaff();
    const toggle = elements.get('auth-user-mode');
    assert.ok(toggle, 'manual-name toggle should be created');
    toggle.onclick();
    const manual = elements.get('auth-user-manual');
    assert.ok(manual, 'manual-name input should be created');
    assert.equal(activeElement, manual);

    manual.value = 'Hidden Manager';
    const pending = context.claimDevice();
    assert.equal(submitted.name, 'Hidden Manager');
    assert.equal(submitted.pin, '2468');
    assert.equal(submit.id, 'auth-submit');
    assert.equal(submit.disabled, true);
    assert.equal(submit.textContent, 'VERIFYING…');
    assert.equal(toggle.disabled, false);
    assert.equal(toggle.textContent, 'Choose from staff list');

    finishRequest({ success: false, error: 'stop after request' });
    await pending;
    assert.equal(submit.disabled, false);
    assert.equal(submit.textContent, 'UNLOCK UPLINK');
    assert.equal(toggle.textContent, 'Choose from staff list');
});
