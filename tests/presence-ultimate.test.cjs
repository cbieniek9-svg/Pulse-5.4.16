'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveAsset, assetMatchesMode, upsertAsset } = require('../src/lib/presence-assets.cjs');
const { getOrderPresenceHint, ingestGatewayBatch } = require('../src/lib/presence-engine.cjs');
const { DEFAULT_GATEWAYS } = require('../src/lib/presence-config.cjs');

function makeDb() {
    const beacon_events = [];
    const heartbeats = {};
    const staff_zones = {};
    const assets = {};

    return {
        getSettings: () => ({}),
        get(sql, ...params) {
            if (sql.includes('presence_assets')) return assets[params[0]] || null;
            if (sql.includes('presence_staff_zones') && sql.includes('beacon_id')) {
                return staff_zones[params[0]] || null;
            }
            return null;
        },
        all(sql, ...params) {
            if (sql.includes('beacon_events')) {
                const since = params[0];
                return beacon_events.filter((e) => e.recorded_at >= since);
            }
            if (sql.includes('presence_gateway_heartbeats')) return Object.values(heartbeats);
            if (sql.includes('presence_staff_zones')) return Object.values(staff_zones);
            if (sql.includes('presence_assets')) return Object.values(assets);
            if (sql.includes('GROUP BY asset_type')) return [];
            return [];
        },
        run(sql, ...params) {
            if (sql.includes('INSERT INTO beacon_events')) {
                beacon_events.push({
                    gateway_id: params[1],
                    beacon_id: params[2],
                    staff_name: params[3],
                    rssi: params[4],
                    recorded_at: params[5],
                    asset_type: params[6],
                    asset_label: params[7],
                });
            }
            if (sql.includes('DELETE FROM beacon_events')) { /* prune */ }
            if (sql.includes('presence_gateway_heartbeats')) {
                heartbeats[params[0]] = { gateway_id: params[0], last_seen: params[2] };
            }
            if (sql.includes('presence_staff_zones')) {
                staff_zones[params[0]] = {
                    beacon_id: params[0],
                    staff_name: params[1],
                    zone_key: params[2],
                    zone: params[3],
                    gateway_id: params[4],
                    rssi: params[5],
                    updated_at: params[6],
                    asset_type: params[7],
                    asset_label: params[8],
                    zone_since: params[9],
                };
            }
            if (sql.includes('INSERT INTO presence_assets') || sql.includes('UPDATE presence_assets')) {
                assets[params[0]] = {
                    beacon_id: params[0],
                    asset_type: params[1] || params[1],
                    label: params[2],
                };
            }
        },
        transaction(fn) { return () => fn(); },
    };
}

const baseConfig = {
    enabled: true,
    asset_mode: 'cart',
    mismatch_threshold: 2,
    allow_discovery: true,
    gateway_by_id: Object.fromEntries(DEFAULT_GATEWAYS.map((g) => [g.id, g])),
    gateways: DEFAULT_GATEWAYS,
    hubs: DEFAULT_GATEWAYS.filter((g) => g.kind === 'hub'),
    aisles: [],
    corners: DEFAULT_GATEWAYS.filter((g) => g.kind === 'corner'),
    staff_beacons: {},
    cart_map: { 'cart-001': 'Cart 1', 'cart-002': 'Cart 2' },
    order_gateway_ids: ['GW-RECV'],
    zone_window_minutes: 3,
    stale_minutes: 5,
    rssi_floor: -95,
};

test('resolveAsset infers cart from cart- prefix', () => {
    const db = makeDb();
    const a = resolveAsset(db, baseConfig, 'cart-007');
    assert.equal(a.asset_type, 'cart');
    assert.match(a.asset_label, /Cart/i);
});

test('assetMatchesMode filters staff vs cart', () => {
    assert.equal(assetMatchesMode({ asset_type: 'cart' }, 'cart'), true);
    assert.equal(assetMatchesMode({ asset_type: 'badge' }, 'cart'), false);
    assert.equal(assetMatchesMode({ asset_type: 'badge' }, 'both'), true);
});

test('getOrderPresenceHint in cart mode counts only carts', () => {
    const db = makeDb();
    const now = new Date().toISOString();
    ingestGatewayBatch(db, {
        gateway_id: 'GW-RECV',
        seen: [
            { beacon_id: 'cart-001', rssi: -60 },
            { beacon_id: 'cart-002', rssi: -62 },
            { beacon_id: 'aa:bb:cc', rssi: -55 },
        ],
        recorded_at: now,
    }, baseConfig);

    const hint = getOrderPresenceHint(db, baseConfig);
    assert.equal(hint.beacon_count, 2);
    assert.ok(hint.count_label.includes('cart'));
});

test('upsertAsset registers cart in registry', () => {
    const db = makeDb();
    upsertAsset(db, { beacon_id: 'cart-099', asset_type: 'cart', label: 'Cart 99' });
    const row = db.get('SELECT * FROM presence_assets WHERE beacon_id = ?', 'cart-099');
    assert.equal(row.label, 'Cart 99');
});
