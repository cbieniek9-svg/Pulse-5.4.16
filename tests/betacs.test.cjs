const test = require('node:test');
const assert = require('node:assert/strict');

const {
    ORDER_ROUTES,
    STATUS_FLOW,
    validateBetacsInsert,
    validateBetacsStatusChange,
    getTvCustomerOrders,
    isBetacsEnabled,
    isBetacsEnvOverride,
} = require('../src/lib/special-orders.cjs');

function makeDb(rows = [], settings = {}) {
    return {
        getSettings: () => settings,
        all(sql, ...params) {
            const s = String(sql);
            if (s.includes("status = ?") && params[0] === 'Open') {
                return rows.filter((r) => r.status === 'Open');
            }
            if (s.includes("source = 'betacs'") && s.includes("status = 'Ordered'")) {
                return rows.filter((r) => r.source === 'betacs' && r.status === 'Ordered');
            }
            return rows;
        },
    };
}

test('ORDER_ROUTES excludes Quotes', () => {
    assert.equal(ORDER_ROUTES.includes('Quotes'), false);
    assert.ok(ORDER_ROUTES.includes('Email orders'));
});

test('validateBetacsInsert requires core fields', () => {
    assert.throws(() => validateBetacsInsert({}), /Customer name/);
    assert.doesNotThrow(() => validateBetacsInsert({
        customer: 'SMITH',
        contact: '403-555-1234',
        needed_by: '2026-05-22',
        taken_by: 'JANE',
        item: '2X COKE',
        location: '3',
        route: 'Pop',
    }));
});

test('validateBetacsStatusChange enforces workflow', () => {
    assert.doesNotThrow(() => validateBetacsStatusChange('New', 'Ordered'));
    assert.throws(() => validateBetacsStatusChange('New', 'Ready'), /Cannot move/);
    assert.deepEqual(STATUS_FLOW.Ordered, ['Ready']);
});

test('getTvCustomerOrders returns legacy Open only when Betacs off', () => {
    const prev = process.env.TGP_CS_BETA_TV;
    delete process.env.TGP_CS_BETA_TV;
    delete process.env.TGP_BETACS_ENABLED;
    const rows = [
        { order_id: 'A', status: 'Open', source: null, location: '1', item: 'X' },
        { order_id: 'B', status: 'Ordered', source: 'betacs', location: '2', item: 'Y' },
    ];
    const tv = getTvCustomerOrders(makeDb(rows, { Betacs_Enabled: '0' }));
    assert.equal(tv.length, 1);
    assert.equal(tv[0].order_id, 'A');
    if (prev === undefined) delete process.env.TGP_CS_BETA_TV;
    else process.env.TGP_CS_BETA_TV = prev;
});

test('getTvCustomerOrders includes beta Ordered when Betacs_Enabled=1', () => {
    const prev = process.env.TGP_CS_BETA_TV;
    delete process.env.TGP_CS_BETA_TV;
    const rows = [
        { order_id: 'A', status: 'Open', source: null, location: '1', item: 'X' },
        { order_id: 'B', status: 'Ordered', source: 'betacs', location: '2', item: 'Y' },
        { order_id: 'C', status: 'New', source: 'betacs', location: '3', item: 'Z' },
    ];
    const tv = getTvCustomerOrders(makeDb(rows, { Betacs_Enabled: '1' }));
    assert.equal(tv.length, 2);
    assert.deepEqual(tv.map((r) => r.order_id).sort(), ['A', 'B']);
    if (prev === undefined) delete process.env.TGP_CS_BETA_TV;
    else process.env.TGP_CS_BETA_TV = prev;
});

test('isBetacsEnabled uses setting and env override', () => {
    const prev = process.env.TGP_CS_BETA_TV;
    assert.equal(isBetacsEnabled({ Betacs_Enabled: '0' }), false);
    assert.equal(isBetacsEnabled({ Betacs_Enabled: '1' }), true);
    process.env.TGP_CS_BETA_TV = '1';
    assert.equal(isBetacsEnabled({ Betacs_Enabled: '0' }), true);
    assert.equal(isBetacsEnvOverride(), true);
    if (prev === undefined) delete process.env.TGP_CS_BETA_TV;
    else process.env.TGP_CS_BETA_TV = prev;
});
