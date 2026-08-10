'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
    ingestGatewayBatch,
    resolveZoneForBeacon,
    getOrderPresenceHint,
    buildPresenceBoard,
} = require('../src/lib/presence-engine.cjs');
const { DEFAULT_GATEWAYS } = require('../src/lib/presence-config.cjs');

function makeDb() {
    const beacon_events = [];
    const heartbeats = {};
    const staff_zones = {};
    const settings = { Presence_Enabled: '1' };

    return {
        getSettings: () => settings,
        get(sql, ...params) {
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
            if (sql.includes('presence_gateway_heartbeats')) {
                return Object.values(heartbeats);
            }
            if (sql.includes('presence_staff_zones')) {
                return Object.values(staff_zones);
            }
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
            if (sql.includes('presence_gateway_heartbeats')) {
                heartbeats[params[0]] = {
                    gateway_id: params[0],
                    label: params[1],
                    last_seen: params[2],
                    last_batch_count: params[3],
                };
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
        },
        transaction(fn) { return () => fn(); },
        _beacon_events: beacon_events,
    };
}

const config = {
    enabled: true,
    asset_mode: 'both',
    mismatch_threshold: 2,
    allow_discovery: false,
    gateway_by_id: Object.fromEntries(DEFAULT_GATEWAYS.map((g) => [g.id, g])),
    gateways: DEFAULT_GATEWAYS,
    hubs: DEFAULT_GATEWAYS.filter((g) => g.kind === 'hub'),
    aisles: [],
    corners: DEFAULT_GATEWAYS.filter((g) => g.kind !== 'hub'),
    staff_beacons: { 'aa:bb:cc:dd': 'Alex', '11:22:33:44': 'Sam' },
    cart_map: {},
    order_gateway_ids: ['GW-RECV'],
    zone_window_minutes: 3,
    stale_minutes: 5,
    rssi_floor: -95,
};

test('ingestGatewayBatch records sightings and heartbeat', () => {
    const db = makeDb();
    const now = new Date().toISOString();
    const result = ingestGatewayBatch(db, {
        gateway_id: 'GW-RECV',
        seen: [
            { beacon_id: 'aa:bb:cc:dd', rssi: -65 },
            { beacon_id: '11:22:33:44', rssi: -70 },
        ],
        recorded_at: now,
    }, config);

    assert.equal(result.accepted, true);
    assert.equal(result.inserted, 2);
    assert.equal(db._beacon_events.length, 2);
});

test('resolveZoneForBeacon picks strongest gateway zone', () => {
    const sightings = [
        { beacon_id: 'aa:bb:cc:dd', gateway_id: 'GW-NW', rssi: -72 },
        { beacon_id: 'aa:bb:cc:dd', gateway_id: 'GW-NE', rssi: -58 },
    ];
    const zone = resolveZoneForBeacon(sightings, config, 'aa:bb:cc:dd');
    assert.equal(zone.zone_key, 'Zone2');
    assert.equal(zone.confidence, 'high');
});

test('getOrderPresenceHint counts badges at receiving gateways', () => {
    const db = makeDb();
    const now = new Date().toISOString();
    ingestGatewayBatch(db, {
        gateway_id: 'GW-RECV',
        seen: [
            { beacon_id: 'aa:bb:cc:dd', rssi: -60 },
            { beacon_id: '11:22:33:44', rssi: -62 },
        ],
        recorded_at: now,
    }, config);

    const hint = getOrderPresenceHint(db, config, { windowMinutes: 15 });
    assert.equal(hint.beacon_count, 2);
    assert.equal(hint.beacon_count, 2);
    assert.deepEqual((hint.display_names || hint.staff_names || []).sort(), ['Alex', 'Sam']);
});

test('buildPresenceBoard reports offline gateway when no heartbeat', () => {
    const db = makeDb();
    const board = buildPresenceBoard(db, config);
    assert.equal(board.enabled, true);
    assert.ok(board.alerts.offline_count >= 1);
});
