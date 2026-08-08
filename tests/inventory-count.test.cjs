'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tgp-inv-count-'));
process.env.TGP_DATA_DIR = tmpRoot;

const { getPulseInventoryDbPath } = require('../src/paths.cjs');
const { getPulseInventoryDb, closePulseInventoryDb } = require('../src/lib/pulse-inventory-db.cjs');
const {
    isInventoryCountEnabled,
    createSession,
    listSessions,
    getSessionDetail,
    insertScan,
    listActiveScans,
    updateLine,
    deleteLine,
    exportSession,
    reopenSession,
    csvEscape,
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

test('pulse inventory DB path is data/pulse_inventory.db under data root', () => {
    assert.equal(getPulseInventoryDbPath(), path.join(tmpRoot, 'data', 'pulse_inventory.db'));
});

test('inventory count feature defaults off unless setting or env enables it', () => {
    const prev = process.env.TGP_INVENTORY_COUNT;
    delete process.env.TGP_INVENTORY_COUNT;
    try {
        assert.equal(isInventoryCountEnabled({}), false);
        assert.equal(isInventoryCountEnabled({ Inventory_Count_Enabled: '0' }), false);
        assert.equal(isInventoryCountEnabled({ Inventory_Count_Enabled: '1' }), true);
        process.env.TGP_INVENTORY_COUNT = '1';
        assert.equal(isInventoryCountEnabled({ Inventory_Count_Enabled: '0' }), true);
        process.env.TGP_INVENTORY_COUNT = '0';
        assert.equal(isInventoryCountEnabled({ Inventory_Count_Enabled: '1' }), false);
    } finally {
        if (prev == null) delete process.env.TGP_INVENTORY_COUNT;
        else process.env.TGP_INVENTORY_COUNT = prev;
    }
});

test('sessions are location-scoped and scans attach to session', (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const a3 = createSession({ location: 'A3', created_by: 'Chris' });
    const frz = createSession({ location: 'Freezer', created_by: 'Chris' });
    insertScan({ session_id: a3.id, upc: '111', quantity: 2 });
    insertScan({ session_id: frz.id, upc: '222', quantity: 1 });

    const a3Lines = listActiveScans({ session_id: a3.id });
    assert.equal(a3Lines.length, 1);
    assert.equal(a3Lines[0].upc, '111');
    assert.equal(a3Lines[0].location, 'A3');

    const open = listSessions({ status: 'open' });
    assert.equal(open.length, 2);
});

test('insertScan rejects empty upc and defaults quantity to 1', (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const s = createSession({ location: 'Bay 1' });
    assert.throws(() => insertScan({ session_id: s.id, upc: '  ' }), /upc is required/);
    const row = insertScan({ session_id: s.id, upc: '333' });
    assert.equal(row.quantity, 1);
});

test('export keeps history but lines are locked until reopen', (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const s = createSession({ location: 'A1' });
    insertScan({ session_id: s.id, upc: '999', quantity: 3 });

    const { csv, count, session } = exportSession(s.id);
    assert.equal(count, 1);
    assert.equal(session.status, 'exported');
    assert.match(csv, /^UPC,QTY,LOCATION,SESSION_TYPE,SESSION_ID\n/);
    assert.match(csv, /999,3,A1,location,/);

    const detail = getSessionDetail(s.id);
    assert.equal(detail.lines.length, 1);

    assert.throws(
        () => updateLine(detail.lines[0].id, { quantity: 5 }),
        (err) => err.code === 'INVENTORY_SESSION_LOCKED' && err.status === 409,
    );
    assert.throws(
        () => insertScan({ session_id: s.id, upc: '888', quantity: 1 }),
        (err) => err.code === 'INVENTORY_SESSION_LOCKED' && err.status === 409,
    );
    assert.equal(getSessionDetail(s.id).lines[0].quantity, 3);

    const reopened = reopenSession(s.id);
    assert.equal(reopened.status, 'open');
    const updated = updateLine(detail.lines[0].id, { quantity: 5 });
    assert.equal(updated.quantity, 5);
    insertScan({ session_id: s.id, upc: '888', quantity: 1 });
    assert.equal(listActiveScans({ session_id: s.id }).length, 2);
});

test('deleteLine removes a scan row', (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const s = createSession({ location: 'Backstock' });
    const row = insertScan({ session_id: s.id, upc: '555', quantity: 2 });
    deleteLine(row.id);
    assert.equal(getSessionDetail(s.id).lines.length, 0);
});

test('csvEscape quotes commas and quotes', () => {
    assert.equal(csvEscape('a,b'), '"a,b"');
    assert.equal(csvEscape('say "hi"'), '"say ""hi"""');
    assert.equal(csvEscape('plain'), 'plain');
});

test('backstock sessions are typed and can run concurrent with location counts', (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const {
        summarizeBackstock,
    } = require('../src/lib/inventory-count.cjs');

    const aisle = createSession({ location: 'A3', session_type: 'location' });
    const cooler = createSession({ location: 'Cooler', session_type: 'backstock' });
    const dry = createSession({ session_type: 'backstock' }); // defaults location Backstock
    assert.equal(aisle.session_type, 'location');
    assert.equal(cooler.session_type, 'backstock');
    assert.equal(dry.location, 'Backstock');
    assert.equal(dry.session_type, 'backstock');

    insertScan({ session_id: cooler.id, upc: '111', quantity: 2 });
    insertScan({ session_id: dry.id, upc: '111', quantity: 3 });
    insertScan({ session_id: aisle.id, upc: '111', quantity: 9 }); // must not enter backstock sum

    const openBs = listSessions({ status: 'open', session_type: 'backstock' });
    assert.equal(openBs.length, 2);

    const summary = summarizeBackstock({ source: 'open' });
    assert.equal(summary.upc_count, 1);
    assert.equal(summary.items[0].upc, '111');
    assert.equal(summary.items[0].quantity, 5);
    assert.equal(summary.total_units, 5);
});

test('close backstock commits location memory used by order finalize + vendor codes', (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const {
        closeBackstockSession,
        finalizeOrderDraft,
        summarizeBackstock,
        listCommittedBackstock,
    } = require('../src/lib/inventory-count.cjs');

    const cooler = createSession({ location: 'Cooler', session_type: 'backstock' });
    const display = createSession({ location: 'Endcap Display', session_type: 'backstock' });
    insertScan({ session_id: cooler.id, upc: '111', quantity: 4 });
    insertScan({ session_id: display.id, upc: '111', quantity: 2 });
    insertScan({ session_id: cooler.id, upc: '222', quantity: 10 });

    // Open walks do not feed order matching until committed.
    assert.equal(summarizeBackstock({ source: 'committed' }).upc_count, 0);

    const closedCooler = closeBackstockSession(cooler.id);
    assert.equal(closedCooler.session.status, 'committed');
    assert.equal(closedCooler.upc_count, 2);
    closeBackstockSession(display.id);

    const memory = listCommittedBackstock();
    assert.equal(memory.filter((r) => r.upc === '111').length, 2);
    assert.equal(summarizeBackstock().items.find((r) => r.upc === '111').quantity, 6);

    const draft = createSession({ location: 'Tuesday grocery', session_type: 'order' });
    insertScan({ session_id: draft.id, upc: '111', quantity: 7 }); // pick 6, still order 1
    insertScan({ session_id: draft.id, upc: '222', quantity: 3 });
    insertScan({ session_id: draft.id, upc: '333', quantity: 5 });

    const result = finalizeOrderDraft(draft.id, {
        lookupItem: (upc) => {
            if (upc === '111') {
                return {
                    code: '057316020840',
                    description: 'Milk',
                    vendor_code: '317636',
                };
            }
            return null;
        },
    });

    const pick111 = result.pick_list.filter((r) => r.upc === '111');
    assert.equal(pick111.length, 2);
    assert.equal(pick111.reduce((s, r) => s + r.pick_qty, 0), 6);
    assert.deepEqual(
        pick111.map((r) => [r.location, r.pick_qty]).sort(),
        [['Cooler', 4], ['Endcap Display', 2]].sort(),
    );
    assert.equal(pick111[0].vendor_code, '317636');

    const clean111 = result.clean_order.find((r) => r.upc === '111');
    assert.equal(clean111.order_qty, 1);
    assert.equal(clean111.vendor_code, '317636');
    assert.match(result.csv.clean_order, /^VENDOR_CODE,UPC,/m);
    assert.match(result.csv.clean_order, /317636/);
    assert.equal(result.session.status, 'exported');

    assert.throws(
        () => closeBackstockSession(createSession({ location: 'A3', session_type: 'location' }).id),
        /Only backstock/i,
    );

    const { getOrderReport } = require('../src/lib/inventory-count.cjs');
    const again = getOrderReport(draft.id);
    assert.equal(again.cached, true);
    assert.equal(again.clean_order.find((r) => r.upc === '111')?.order_qty, 1);
    assert.equal(again.csv.pick_list.includes('PICK_QTY'), true);
    assert.ok(getSessionDetail(draft.id).session.has_report);
});

test('finalize matches backstock when UPC check digit differs (ketchup case)', (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const { closeBackstockSession, finalizeOrderDraft } = require('../src/lib/inventory-count.cjs');
    const { upcCheckDigit } = require('../src/lib/item-catalog.cjs');

    // Same product: scanned with check digit vs typed/filed without.
    const body = '05731600105';
    const withCheck = `${body}${upcCheckDigit(body)}`; // 057316001054
    const withoutCheck = '5731600105';

    const bs = createSession({ location: 'Cooler', session_type: 'backstock' });
    insertScan({ session_id: bs.id, upc: withCheck, quantity: 3 });
    closeBackstockSession(bs.id);

    const draft = createSession({ location: 'Order', session_type: 'order' });
    insertScan({ session_id: draft.id, upc: withoutCheck, quantity: 3 });

    const result = finalizeOrderDraft(draft.id, {
        lookupItem: (upc) => {
            // Catalog files short form; both scans resolve to same item (like Heinz).
            if (upc === withCheck || upc === withoutCheck || upc === body) {
                return {
                    code: withoutCheck,
                    description: 'HEINZ KETCHUP',
                    vendor_code: '668913',
                };
            }
            return null;
        },
    });

    assert.equal(result.pick_list.length, 1);
    assert.equal(result.pick_list[0].pick_qty, 3);
    assert.equal(result.clean_order.length, 0, 'should not leave ketchup on clean order');
    assert.ok(result.pick_list[0].matched_backstock_upcs.length >= 1);
    assert.equal(result.pick_list[0].vendor_code, '668913');
});

test('finalize matches via catalog code when raw UPC strings differ', (t) => {
    if (!sqliteReady(t)) return;
    resetDb();
    const { closeBackstockSession, finalizeOrderDraft } = require('../src/lib/inventory-count.cjs');
    const { normalizeCode } = require('../src/lib/item-catalog.cjs');

    // Mimic: backstock scan kept a trailing digit; order draft dropped it.
    // Both resolve to the same catalog row / vendor — must still subtract.
    const backstockUpc = '013000001512';
    const orderUpc = '01300000151';
    const catalog = {
        code: '1300000151',
        description: 'HEINZ KETCHUP',
        vendor_code: '2448967',
    };
    const lookup = (upc) => {
        const n = normalizeCode(upc);
        const hit = [backstockUpc, orderUpc, catalog.code, normalizeCode(backstockUpc), normalizeCode(orderUpc)]
            .some((x) => x === upc || normalizeCode(x) === n);
        return hit ? catalog : null;
    };

    const bs = createSession({ location: 'Dry', session_type: 'backstock' });
    insertScan({ session_id: bs.id, upc: backstockUpc, quantity: 2 });
    closeBackstockSession(bs.id, { lookupItem: lookup });

    const draft = createSession({ location: 'Order', session_type: 'order' });
    insertScan({ session_id: draft.id, upc: orderUpc, quantity: 2 });

    const result = finalizeOrderDraft(draft.id, { lookupItem: lookup });

    assert.equal(result.pick_list.reduce((s, r) => s + r.pick_qty, 0), 2);
    assert.equal(result.clean_order.length, 0);
});
