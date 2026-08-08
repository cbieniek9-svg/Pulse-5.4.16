'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-inv-integrity-'));
process.env.TGP_DATA_DIR = tmpRoot;

const {
    canAccessInventoryCount,
    CLERK_PERMISSIONS,
    defaultPermissionsForRole,
} = require('../src/lib/staff-permissions.cjs');
const { registerInventoryCountRoutes } = require('../src/routes/manager/inventory-count.cjs');
const { getPulseInventoryDb, closePulseInventoryDb } = require('../src/lib/pulse-inventory-db.cjs');
const {
    createSession,
    insertScan,
    updateLine,
    deleteLine,
    closeBackstockSession,
    reopenSession,
    listCommittedBackstock,
    getSessionDetail,
} = require('../src/lib/inventory-count.cjs');

function sqliteReady(t) {
    try {
        getPulseInventoryDb();
        return true;
    } catch (e) {
        t.skip(`better-sqlite3 is not loadable in this environment: ${e.message || e}`);
        return false;
    }
}

function resetDb() {
    closePulseInventoryDb();
    const db = getPulseInventoryDb();
    db.prepare('DELETE FROM count_lines').run();
    db.prepare('DELETE FROM count_sessions').run();
    try { db.prepare('DELETE FROM backstock_on_hand').run(); } catch (_) { /* schema may lag */ }
    return db;
}

test.after(() => {
    closePulseInventoryDb();
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) { /* ignore */ }
});

function staffDb(permissionsByName) {
    return {
        getSettings: () => ({ Inventory_Count_Enabled: '1' }),
        findStaffByName: (name) => {
            const permissions = permissionsByName[name];
            if (permissions == null) return null;
            return { name, permissions };
        },
    };
}

function harness(session, permissionsByName = {}) {
    const routes = new Map();
    const server = {
        get(p, handler) { routes.set(`GET ${p}`, handler); },
        post(p, handler) { routes.set(`POST ${p}`, handler); },
        patch(p, handler) { routes.set(`PATCH ${p}`, handler); },
        delete(p, handler) { routes.set(`DELETE ${p}`, handler); },
    };
    const db = staffDb(permissionsByName);
    const ctx = {
        db,
        wrap: (handler) => handler,
        fail(res, status, message, code = null) {
            res.status(status).json({
                error: message,
                ...(code ? { code } : {}),
            });
        },
        requireSession() { return session; },
    };
    registerInventoryCountRoutes(server, ctx);
    return { routes, db };
}

function response() {
    return {
        statusCode: 200,
        body: null,
        status(code) { this.statusCode = code; return this; },
        json(body) { this.body = body; return this; },
        set() { return this; },
    };
}

test('canAccessInventoryCount false for clerk without perm; true with inventory; true for manager', () => {
    const db = staffDb({
        Sam: 'tasks',
        Pat: 'tasks,inventory',
    });
    assert.equal(canAccessInventoryCount(db, { name: 'Sam', role: 'Clerk' }), false);
    assert.equal(canAccessInventoryCount(db, { name: 'Pat', role: 'Clerk' }), true);
    assert.equal(canAccessInventoryCount(db, { name: 'Boss', role: 'Manager' }), true);
    assert.equal(canAccessInventoryCount(db, { name: 'SM', role: 'Store Manager' }), true);
});

test('CLERK_PERMISSIONS includes inventory and defaults do not auto-grant it', () => {
    const keys = CLERK_PERMISSIONS.map((p) => p.key);
    assert.ok(keys.includes('inventory'), 'CLERK_PERMISSIONS must include inventory');
    const inv = CLERK_PERMISSIONS.find((p) => p.key === 'inventory');
    assert.equal(inv.label, 'Inventory count (/count)');
    assert.equal(defaultPermissionsForRole('Clerk', 1), 'tasks');
    assert.equal(defaultPermissionsForRole('Premium Clerk', 1), 'tasks,receiving');
    assert.ok(!defaultPermissionsForRole('Clerk', 1).includes('inventory'));
    assert.ok(!defaultPermissionsForRole('Premium Clerk', 1).includes('inventory'));
});

test('clerk without inventory permission gets 403 on create session', async () => {
    const prev = process.env.TGP_INVENTORY_COUNT;
    delete process.env.TGP_INVENTORY_COUNT;
    try {
        const { routes } = harness(
            { name: 'Sam', role: 'Clerk' },
            { Sam: 'tasks' },
        );
        const res = response();
        await routes.get('POST /api/inventory/sessions')(
            { body: { location: 'A1' } },
            res,
        );
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.code, 'INVENTORY_PERMISSION_REQUIRED');
    } finally {
        if (prev == null) delete process.env.TGP_INVENTORY_COUNT;
        else process.env.TGP_INVENTORY_COUNT = prev;
    }
});

test('requireCountAuth gates on canAccessInventoryCount with INVENTORY_PERMISSION_REQUIRED', () => {
    const routesSource = fs.readFileSync(
        path.join(__dirname, '../src/routes/manager/inventory-count.cjs'),
        'utf8',
    );
    assert.ok(
        routesSource.includes('canAccessInventoryCount'),
        'inventory-count routes must use canAccessInventoryCount',
    );
    assert.ok(
        routesSource.includes('INVENTORY_PERMISSION_REQUIRED'),
        'requireCountAuth must fail with INVENTORY_PERMISSION_REQUIRED',
    );
    assert.ok(
        /requireCountAuth[\s\S]*canAccessInventoryCount/.test(routesSource),
        'requireCountAuth must call canAccessInventoryCount',
    );
});

test('GET /api/inventory/config stays public (no count auth)', async () => {
    const prev = process.env.TGP_INVENTORY_COUNT;
    delete process.env.TGP_INVENTORY_COUNT;
    try {
        const { routes } = harness(null, {});
        const res = response();
        await routes.get('GET /api/inventory/config')({}, res);
        assert.equal(res.statusCode, 200);
        assert.equal(res.body.enabled, true);
        assert.ok(!res.body.code);
    } finally {
        if (prev == null) delete process.env.TGP_INVENTORY_COUNT;
        else process.env.TGP_INVENTORY_COUNT = prev;
    }
});

test('updateLine on committed session throws INVENTORY_SESSION_LOCKED and leaves backstock_on_hand', (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const s = createSession({ location: 'Cooler', session_type: 'backstock' });
    const line = insertScan({ session_id: s.id, upc: '111', quantity: 5 });
    closeBackstockSession(s.id);

    assert.throws(
        () => updateLine(line.id, { quantity: 99 }),
        (err) => err.code === 'INVENTORY_SESSION_LOCKED' && err.status === 409,
    );

    const memory = listCommittedBackstock().filter((r) => r.upc === '111' && r.location === 'Cooler');
    assert.equal(memory.length, 1);
    assert.equal(memory[0].quantity, 5);
    assert.equal(getSessionDetail(s.id).lines[0].quantity, 5);
});

test('deleteLine and insertScan on committed session throw INVENTORY_SESSION_LOCKED', (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const s = createSession({ location: 'Dry', session_type: 'backstock' });
    const line = insertScan({ session_id: s.id, upc: '222', quantity: 3 });
    closeBackstockSession(s.id);

    assert.throws(
        () => deleteLine(line.id),
        (err) => err.code === 'INVENTORY_SESSION_LOCKED' && err.status === 409,
    );
    assert.throws(
        () => insertScan({ session_id: s.id, upc: '333', quantity: 1 }),
        (err) => err.code === 'INVENTORY_SESSION_LOCKED' && err.status === 409,
    );
    assert.equal(getSessionDetail(s.id).lines.length, 1);
});

test('reopen clears backstock_on_hand for source_session_id', (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const s = createSession({ location: 'Cooler', session_type: 'backstock' });
    insertScan({ session_id: s.id, upc: '111', quantity: 5 });
    closeBackstockSession(s.id);
    assert.ok(listCommittedBackstock().some((r) => r.source_session_id === s.id));

    const reopened = reopenSession(s.id);
    assert.equal(reopened.status, 'open');
    assert.equal(reopened.exported_at, null);
    assert.equal(
        listCommittedBackstock().filter((r) => r.source_session_id === s.id).length,
        0,
    );
});

test('after reopen, edit + re-commit writes new qty to memory', (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const s = createSession({ location: 'Cooler', session_type: 'backstock' });
    const line = insertScan({ session_id: s.id, upc: '111', quantity: 5 });
    closeBackstockSession(s.id);

    reopenSession(s.id);
    updateLine(line.id, { quantity: 99 });
    closeBackstockSession(s.id);

    const memory = listCommittedBackstock().filter((r) => r.upc === '111' && r.location === 'Cooler');
    assert.equal(memory.length, 1);
    assert.equal(memory[0].quantity, 99);
    assert.equal(memory[0].source_session_id, s.id);
});

test('PATCH line route surfaces INVENTORY_SESSION_LOCKED code', async (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const prev = process.env.TGP_INVENTORY_COUNT;
    process.env.TGP_INVENTORY_COUNT = '1';
    try {
        const s = createSession({ location: 'Cooler', session_type: 'backstock' });
        const line = insertScan({ session_id: s.id, upc: '111', quantity: 5 });
        closeBackstockSession(s.id);

        const { routes } = harness(
            { name: 'Boss', role: 'Manager' },
            { Boss: 'tasks,inventory' },
        );
        const res = response();
        await routes.get('PATCH /api/inventory/lines/:id')(
            { params: { id: String(line.id) }, body: { quantity: 99 } },
            res,
        );
        assert.equal(res.statusCode, 409);
        assert.equal(res.body.code, 'INVENTORY_SESSION_LOCKED');
    } finally {
        if (prev == null) delete process.env.TGP_INVENTORY_COUNT;
        else process.env.TGP_INVENTORY_COUNT = prev;
    }
});
