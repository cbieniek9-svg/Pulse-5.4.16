'use strict';

const crypto = require('crypto');

const SETTING_ENABLED = 'Presence_Enabled';
const SETTING_GATEWAY_KEY = 'Presence_Gateway_Key';
const SETTING_GATEWAY_MAP = 'Presence_Gateway_Map';
const SETTING_STAFF_BEACONS = 'Presence_Staff_Beacons';
const SETTING_CART_MAP = 'Presence_Cart_Map';
const SETTING_ORDER_GATEWAYS = 'Presence_Order_Gateways';
const SETTING_STALE_MINUTES = 'Presence_Gateway_Stale_Minutes';
const SETTING_ZONE_WINDOW = 'Presence_Zone_Window_Minutes';
const SETTING_RSSI_FLOOR = 'Presence_RSSI_Floor';
const SETTING_ASSET_MODE = 'Presence_Asset_Mode';
const SETTING_ALLOW_DISCOVERY = 'Presence_Allow_Discovery';
const SETTING_MISMATCH_THRESHOLD = 'Presence_Mismatch_Threshold';

const ASSET_MODES = ['staff', 'cart', 'both'];

const DEFAULT_GATEWAYS = [
    {
        id: 'GW-RECV',
        kind: 'hub',
        label: 'Receiving / Order Hub',
        zone: 'Receiving',
        zone_key: 'Receiving',
        order_count: true,
        rssi_min: -88,
        battery_powered: false,
        parent_hub_id: null,
    },
    {
        id: 'GW-NW',
        kind: 'corner',
        label: 'Northwest',
        zone: 'Zone 1',
        zone_key: 'Zone1',
        order_count: false,
        rssi_min: -90,
        battery_powered: false,
        parent_hub_id: 'GW-RECV',
    },
    {
        id: 'GW-NE',
        kind: 'corner',
        label: 'Northeast',
        zone: 'Zone 2',
        zone_key: 'Zone2',
        order_count: false,
        rssi_min: -90,
        battery_powered: false,
        parent_hub_id: 'GW-RECV',
    },
    {
        id: 'GW-S',
        kind: 'corner',
        label: 'South / Frozen',
        zone: 'Zone 3',
        zone_key: 'Zone3',
        order_count: false,
        rssi_min: -90,
        battery_powered: false,
        parent_hub_id: 'GW-RECV',
    },
];

/** Template aisle receivers (disabled until hardware) — smart cart + dumb aisle model */
const TEMPLATE_AISLE_GATEWAYS = [
    'A01', 'A02', 'A03', 'A04', 'A05', 'A06',
    'A07', 'A08', 'A09', 'A10', 'A11', 'A12',
].map((aisle) => ({
    id: `AISLE-${aisle}`,
    kind: 'aisle',
    label: `Aisle ${aisle}`,
    zone: aisle <= 'A06' ? 'Zone 1' : (aisle <= 'A09' ? 'Zone 2' : 'Zone 3'),
    zone_key: aisle <= 'A06' ? 'Zone1' : (aisle <= 'A09' ? 'Zone2' : 'Zone3'),
    order_count: false,
    rssi_min: -92,
    battery_powered: true,
    parent_hub_id: 'GW-RECV',
    enabled: false,
}));

function parseJson(raw, fallback) {
    try {
        return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
        return fallback;
    }
}

function normalizeGateway(g) {
    const id = String(g?.id || '').trim();
    if (!id) return null;
    const enabled = g?.enabled !== false && g?.enabled !== 0 && g?.enabled !== '0';
    return {
        id,
        kind: String(g?.kind || (id.startsWith('AISLE-') ? 'aisle' : 'corner')).trim(),
        label: String(g?.label || id).trim(),
        zone: String(g?.zone || 'General').trim(),
        zone_key: String(g?.zone_key || g?.zone || 'General').trim(),
        order_count: g?.order_count === true || g?.order_count === '1' || g?.order_count === 1,
        rssi_min: Number.isFinite(Number(g?.rssi_min)) ? Number(g.rssi_min) : -90,
        battery_powered: g?.battery_powered === true || g?.battery_powered === 1,
        parent_hub_id: g?.parent_hub_id ? String(g.parent_hub_id).trim() : null,
        enabled,
    };
}

function loadGatewaysFromCatalog(db) {
    try {
        const rows = db.all('SELECT * FROM presence_gateway_catalog WHERE enabled = 1 ORDER BY gateway_id');
        if (!rows?.length) return null;
        return rows.map((r) => normalizeGateway({
            id: r.gateway_id,
            kind: r.kind,
            label: r.label,
            zone: r.zone,
            zone_key: r.zone_key,
            order_count: r.order_count,
            rssi_min: r.rssi_min,
            battery_powered: r.battery_powered,
            parent_hub_id: r.parent_hub_id,
            enabled: r.enabled,
        })).filter(Boolean);
    } catch (_) {
        return null;
    }
}

function syncGatewayCatalog(db, gateways) {
    const now = new Date().toISOString();
    (gateways || []).forEach((g) => {
        if (!g?.id) return;
        db.run(
            `INSERT OR REPLACE INTO presence_gateway_catalog
             (gateway_id, kind, label, zone_key, zone, parent_hub_id, order_count, rssi_min, enabled, battery_powered, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                COALESCE((SELECT created_at FROM presence_gateway_catalog WHERE gateway_id = ?), ?), ?)`,
            g.id,
            g.kind || 'corner',
            g.label,
            g.zone_key,
            g.zone,
            g.parent_hub_id,
            g.order_count ? 1 : 0,
            g.rssi_min,
            g.enabled !== false ? 1 : 0,
            g.battery_powered ? 1 : 0,
            g.id,
            now,
            now,
        );
    });
}

function loadPresenceConfig(db) {
    const settings = db.getSettings ? db.getSettings() : {};
    const enabled = settings[SETTING_ENABLED] === '1';
    let gatewayKey = String(settings[SETTING_GATEWAY_KEY] || '').trim();
    if (enabled && !gatewayKey) {
        gatewayKey = crypto.randomBytes(16).toString('hex');
        db.run(
            'INSERT OR REPLACE INTO settings (setting_name, setting_value) VALUES (?, ?)',
            SETTING_GATEWAY_KEY,
            gatewayKey,
        );
    }

    const rawGateways = parseJson(settings[SETTING_GATEWAY_MAP], null);
    let gatewayList = (Array.isArray(rawGateways) ? rawGateways : DEFAULT_GATEWAYS)
        .concat(TEMPLATE_AISLE_GATEWAYS);
    const catalogGateways = loadGatewaysFromCatalog(db);
    if (catalogGateways?.length) gatewayList = catalogGateways;

    const gateways = gatewayList
        .map(normalizeGateway)
        .filter((g) => g && g.enabled !== false);

    const staffBeacons = parseJson(settings[SETTING_STAFF_BEACONS], {});
    const cartMap = parseJson(settings[SETTING_CART_MAP], {});
    const assetMode = ASSET_MODES.includes(settings[SETTING_ASSET_MODE])
        ? settings[SETTING_ASSET_MODE]
        : 'staff';

    const orderGatewayIds = parseJson(settings[SETTING_ORDER_GATEWAYS], null);
    const orderGateways = Array.isArray(orderGatewayIds) && orderGatewayIds.length
        ? orderGatewayIds.map(String)
        : gateways.filter((g) => g.order_count).map((g) => g.id);

    return {
        enabled,
        gateway_key: gatewayKey,
        gateways,
        gateway_by_id: Object.fromEntries(gateways.map((g) => [g.id, g])),
        hubs: gateways.filter((g) => g.kind === 'hub'),
        aisles: gateways.filter((g) => g.kind === 'aisle'),
        corners: gateways.filter((g) => g.kind === 'corner'),
        staff_beacons: typeof staffBeacons === 'object' && staffBeacons ? staffBeacons : {},
        cart_map: typeof cartMap === 'object' && cartMap ? cartMap : {},
        asset_mode: assetMode,
        allow_discovery: settings[SETTING_ALLOW_DISCOVERY] === '1',
        mismatch_threshold: Math.max(1, Number(settings[SETTING_MISMATCH_THRESHOLD]) || 2),
        order_gateway_ids: orderGateways,
        stale_minutes: Math.max(1, Number(settings[SETTING_STALE_MINUTES]) || 5),
        zone_window_minutes: Math.max(1, Number(settings[SETTING_ZONE_WINDOW]) || 3),
        rssi_floor: Number(settings[SETTING_RSSI_FLOOR]) || -95,
        beaconToStaff,
    };
}

function beaconToStaff(config, beaconId) {
    const key = String(beaconId || '').trim().toLowerCase();
    if (!key) return null;
    const map = config.staff_beacons || {};
    for (const [uuid, name] of Object.entries(map)) {
        if (String(uuid).trim().toLowerCase() === key) return String(name).trim();
    }
    return null;
}

function savePresenceSettings(db, patch) {
    const pairs = [
        [SETTING_ENABLED, patch.enabled != null ? (patch.enabled ? '1' : '0') : null],
        [SETTING_GATEWAY_MAP, patch.gateways != null ? JSON.stringify(patch.gateways) : null],
        [SETTING_STAFF_BEACONS, patch.staff_beacons != null ? JSON.stringify(patch.staff_beacons) : null],
        [SETTING_CART_MAP, patch.cart_map != null ? JSON.stringify(patch.cart_map) : null],
        [SETTING_ORDER_GATEWAYS, patch.order_gateway_ids != null ? JSON.stringify(patch.order_gateway_ids) : null],
        [SETTING_STALE_MINUTES, patch.stale_minutes != null ? String(patch.stale_minutes) : null],
        [SETTING_ZONE_WINDOW, patch.zone_window_minutes != null ? String(patch.zone_window_minutes) : null],
        [SETTING_RSSI_FLOOR, patch.rssi_floor != null ? String(patch.rssi_floor) : null],
        [SETTING_ASSET_MODE, patch.asset_mode != null ? String(patch.asset_mode) : null],
        [SETTING_ALLOW_DISCOVERY, patch.allow_discovery != null ? (patch.allow_discovery ? '1' : '0') : null],
        [SETTING_MISMATCH_THRESHOLD, patch.mismatch_threshold != null ? String(patch.mismatch_threshold) : null],
    ];
    pairs.forEach(([name, value]) => {
        if (value == null) return;
        db.run(
            'INSERT OR REPLACE INTO settings (setting_name, setting_value) VALUES (?, ?)',
            name,
            value,
        );
    });
    if (patch.gateways != null) {
        try { syncGatewayCatalog(db, patch.gateways.map(normalizeGateway).filter(Boolean)); } catch (_) { /* pre-migration */ }
    }
    if (patch.cart_map != null) {
        try {
            const { seedCartsFromMap } = require('./presence-assets.cjs');
            seedCartsFromMap(db, patch.cart_map);
        } catch (_) { /* pre-migration */ }
    }
}

function getAssetModeLabel(mode) {
    if (mode === 'cart') return 'carts';
    if (mode === 'both') return 'carts & badges';
    return 'badges';
}

module.exports = {
    SETTING_ENABLED,
    SETTING_GATEWAY_KEY,
    SETTING_ASSET_MODE,
    ASSET_MODES,
    DEFAULT_GATEWAYS,
    TEMPLATE_AISLE_GATEWAYS,
    loadPresenceConfig,
    savePresenceSettings,
    beaconToStaff,
    getAssetModeLabel,
    parseJson,
    normalizeGateway,
    syncGatewayCatalog,
};
