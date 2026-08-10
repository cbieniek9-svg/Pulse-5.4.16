'use strict';

const crypto = require('crypto');
const { loadPresenceConfig, beaconToStaff, getAssetModeLabel } = require('./presence-config.cjs');
const { resolveAsset, assetMatchesMode } = require('./presence-assets.cjs');
const {
    buildPresenceAnalytics,
    enrichOrderHint,
    buildStaleReceivingCarts,
} = require('./presence-analytics.cjs');

const PRUNE_KEEP_HOURS = 48;
const MAX_EVENTS_PER_INGEST = 500;
const MAX_GATEWAY_ID_LEN = 32;
/** Max gateways including configured + auto-discovered. */
const MAX_GATEWAYS = 128;
const GATEWAY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,31}$/;

function isPresenceEnabled(settings) {
    return settings?.Presence_Enabled === '1';
}

function rssiWeight(rssi, floor) {
    const n = Number(rssi);
    if (!Number.isFinite(n) || n < floor) return 0;
    return Math.max(0, n + 100);
}

function clampRecordedAt(recorded_at) {
    const serverIso = new Date().toISOString();
    if (recorded_at == null || recorded_at === '') return serverIso;
    const ms = Date.parse(recorded_at);
    if (!Number.isFinite(ms) || ms > Date.now()) return serverIso;
    return new Date(ms).toISOString();
}

function assertValidGatewayId(gwId) {
    const id = String(gwId || '').trim();
    if (!id || id.length > MAX_GATEWAY_ID_LEN || !GATEWAY_ID_RE.test(id)) {
        throw Object.assign(new Error(`Invalid gateway_id: ${gwId}`), { status: 400 });
    }
    return id;
}

function ensureGatewayKnown(db, config, gwId, meta = {}) {
    const id = assertValidGatewayId(gwId);
    if (config.gateway_by_id[id]) return config.gateway_by_id[id];
    if (!config.allow_discovery) {
        throw Object.assign(new Error(`Unknown gateway_id: ${id}`), { status: 400 });
    }
    if ((config.gateways || []).length >= MAX_GATEWAYS) {
        throw Object.assign(new Error('Too many discovered gateways'), { status: 400 });
    }
    const kind = id.startsWith('AISLE-') ? 'aisle' : 'corner';
    const discovered = {
        id,
        kind,
        label: meta.label || `Discovered ${id}`,
        zone: meta.zone || 'General',
        zone_key: meta.zone_key || 'General',
        order_count: false,
        rssi_min: -92,
        battery_powered: kind === 'aisle',
        parent_hub_id: config.hubs?.[0]?.id || 'GW-RECV',
        enabled: true,
    };
    config.gateways.push(discovered);
    config.gateway_by_id[id] = discovered;
    try {
        const { syncGatewayCatalog } = require('./presence-config.cjs');
        syncGatewayCatalog(db, [discovered]);
    } catch (_) { /* catalog table may not exist yet */ }
    return discovered;
}

function ingestGatewayBatch(db, {
    gateway_id,
    seen = [],
    firmware = '',
    recorded_at,
    relayed_by = null,
}, config) {
    if (!config?.enabled) {
        return { accepted: false, reason: 'Presence_Enabled is off' };
    }
    const gwId = String(gateway_id || '').trim();
    if (!gwId) throw Object.assign(new Error('gateway_id required'), { status: 400 });

    const gw = ensureGatewayKnown(db, config, gwId, { label: relayed_by ? `Relay ${gwId}` : undefined });
    const now = clampRecordedAt(recorded_at);
    const rows = (seen || []).slice(0, MAX_EVENTS_PER_INGEST);
    let inserted = 0;

    const runIngest = () => {
        rows.forEach((row) => {
            const beaconId = String(row.beacon_id || row.uuid || '').trim().toLowerCase();
            if (!beaconId) return;
            const rssi = row.rssi != null ? Number(row.rssi) : null;
            const asset = resolveAsset(db, config, beaconId);
            const id = `BE-${gwId}-${beaconId}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
            db.run(
                `INSERT INTO beacon_events
                 (id, gateway_id, beacon_id, staff_name, event_type, rssi, recorded_at, asset_type, asset_label)
                 VALUES (?, ?, ?, ?, 'sight', ?, ?, ?, ?)`,
                id,
                gwId,
                beaconId,
                asset.staff_name,
                rssi,
                now,
                asset.asset_type,
                asset.asset_label,
            );
            inserted += 1;
        });

        db.run(
            `INSERT OR REPLACE INTO presence_gateway_heartbeats
             (gateway_id, label, last_seen, last_batch_count, firmware)
             VALUES (?, ?, ?, ?, ?)`,
            gwId,
            gw.label,
            now,
            rows.length,
            String(firmware || relayed_by || '').slice(0, 64),
        );

        const cutoff = new Date(Date.now() - PRUNE_KEEP_HOURS * 3600000).toISOString();
        db.run('DELETE FROM beacon_events WHERE recorded_at < ?', cutoff);
    };

    if (db.transaction) db.transaction(runIngest)();
    else runIngest();

    const zoneUpdates = recomputeAssetZones(db, config, { sinceMinutes: config.zone_window_minutes });

    return {
        accepted: true,
        gateway_id: gwId,
        gateway_kind: gw.kind,
        inserted,
        batch_size: rows.length,
        zone_updates: zoneUpdates.updated,
        relayed_by: relayed_by || null,
        at: now,
    };
}

function getRecentSightings(db, { sinceMinutes = 3, gatewayIds = null } = {}) {
    const since = new Date(Date.now() - sinceMinutes * 60000).toISOString();
    let sql = `
        SELECT gateway_id, beacon_id, staff_name, rssi, recorded_at, asset_type, asset_label
        FROM beacon_events
        WHERE recorded_at >= ?
    `;
    const params = [since];
    if (gatewayIds?.length) {
        sql += ` AND gateway_id IN (${gatewayIds.map(() => '?').join(',')})`;
        params.push(...gatewayIds);
    }
    sql += ' ORDER BY recorded_at DESC';
    return db.all(sql, ...params);
}

function resolveZoneForBeacon(sightings, config, beaconId) {
    const bid = String(beaconId).toLowerCase();
    const zoneScores = {};
    let bestGateway = null;
    let bestRssi = -999;

    sightings
        .filter((s) => String(s.beacon_id).toLowerCase() === bid)
        .forEach((s) => {
            const gw = config.gateway_by_id[s.gateway_id];
            if (!gw) return;
            // Reject missing RSSI before Number() — null/'' coerce to 0 and would skew zones.
            if (s.rssi == null || s.rssi === '') return;
            const rssi = Number(s.rssi);
            if (!Number.isFinite(rssi)) return;
            if (rssi > bestRssi) {
                bestRssi = rssi;
                bestGateway = gw;
            }
            const w = rssiWeight(rssi, config.rssi_floor);
            if (w <= 0 || rssi < gw.rssi_min) return;
            const zk = gw.zone_key || gw.zone;
            zoneScores[zk] = (zoneScores[zk] || 0) + w;
        });

    const ranked = Object.entries(zoneScores).sort((a, b) => b[1] - a[1]);
    if (!ranked.length) {
        return { zone_key: null, zone: null, gateway_id: bestGateway?.id || null, confidence: 'none' };
    }

    const [topKey, topScore] = ranked[0];
    const second = ranked[1]?.[1] || 0;
    const margin = second > 0 ? (topScore - second) / topScore : 1;
    const gwMatch = config.gateways.find((g) => (g.zone_key || g.zone) === topKey);

    return {
        zone_key: topKey,
        zone: gwMatch?.zone || topKey,
        gateway_id: gwMatch?.id || bestGateway?.id || null,
        confidence: margin >= 0.15 ? 'high' : 'low',
        rssi: bestRssi,
    };
}

function recomputeAssetZones(db, config, { sinceMinutes } = {}) {
    const windowMin = sinceMinutes || config.zone_window_minutes;
    const sightings = getRecentSightings(db, { sinceMinutes: windowMin });
    const beacons = [...new Set(sightings.map((s) => String(s.beacon_id).toLowerCase()))];
    let updated = 0;
    const now = new Date().toISOString();
    const liveAssets = [];

    beacons.forEach((beaconId) => {
        const zone = resolveZoneForBeacon(sightings, config, beaconId);
        if (!zone.zone_key) return;
        const asset = resolveAsset(db, config, beaconId);
        let prev = null;
        try {
            prev = db.get(
                'SELECT zone_key, zone_since FROM presence_staff_zones WHERE beacon_id = ?',
                beaconId,
            );
        } catch (_) {
            prev = null;
        }
        const zoneSince = (prev && prev.zone_key === zone.zone_key && prev.zone_since)
            ? prev.zone_since
            : now;
        db.run(
            `INSERT OR REPLACE INTO presence_staff_zones
             (beacon_id, staff_name, zone_key, zone, gateway_id, rssi, updated_at, asset_type, asset_label, zone_since)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            beaconId,
            asset.staff_name,
            zone.zone_key,
            zone.zone,
            zone.gateway_id,
            zone.rssi != null ? zone.rssi : null,
            now,
            asset.asset_type,
            asset.asset_label,
            zoneSince,
        );
        liveAssets.push({
            beacon_id: beaconId,
            asset_type: asset.asset_type,
            asset_label: asset.asset_label,
            staff_name: asset.staff_name,
            zone_key: zone.zone_key,
            zone: zone.zone,
            gateway_id: zone.gateway_id,
            rssi: zone.rssi,
            updated_at: now,
            zone_since: zoneSince,
            confidence: zone.confidence,
        });
        updated += 1;
    });

    return { updated, beacon_count: beacons.length, live_assets: liveAssets };
}

function getOrderPresenceHint(db, config, { windowMinutes = 15 } = {}) {
    if (!config?.enabled) return null;

    const gatewayIds = config.order_gateway_ids || [];
    if (!gatewayIds.length) return null;

    const sightings = getRecentSightings(db, { sinceMinutes: windowMinutes, gatewayIds });
    const byBeacon = new Map();

    sightings.forEach((s) => {
        const bid = String(s.beacon_id).toLowerCase();
        const gw = config.gateway_by_id[s.gateway_id];
        if (!gw) return;
        const rssi = Number(s.rssi);
        if (!Number.isFinite(rssi) || rssi < gw.rssi_min) return;
        const asset = resolveAsset(db, config, bid);
        if (!assetMatchesMode(asset, config.asset_mode)) return;

        const prev = byBeacon.get(bid);
        if (!prev || rssi > prev.best_rssi) {
            byBeacon.set(bid, {
                beacon_id: bid,
                asset_type: asset.asset_type,
                asset_label: asset.asset_label,
                staff_name: asset.staff_name,
                best_rssi: rssi,
                gateway_id: s.gateway_id,
            });
        }
    });

    const assets = [...byBeacon.values()];
    const staffNames = [...new Set(assets.map((b) => b.staff_name).filter(Boolean))];
    const byGateway = {};
    gatewayIds.forEach((id) => { byGateway[id] = 0; });
    assets.forEach((b) => {
        if (byGateway[b.gateway_id] != null) byGateway[b.gateway_id] += 1;
    });

    const raw = {
        window_minutes: windowMinutes,
        beacon_count: assets.length,
        staff_count: staffNames.length || assets.length,
        staff_names: staffNames,
        assets,
        badges: assets,
        by_gateway: byGateway,
        gateway_ids: gatewayIds,
        asset_mode: config.asset_mode,
    };
    return enrichOrderHint(raw, config);
}

function getGatewayHealth(db, config) {
    const now = Date.now();
    const staleMs = config.stale_minutes * 60000;
    const rows = db.all('SELECT * FROM presence_gateway_heartbeats ORDER BY gateway_id');
    const byId = Object.fromEntries(rows.map((r) => [r.gateway_id, r]));

    return config.gateways.map((g) => {
        const row = byId[g.id];
        const lastMs = row ? Date.parse(row.last_seen) : 0;
        const ageMs = lastMs ? now - lastMs : Infinity;
        const online = ageMs <= staleMs;
        return {
            id: g.id,
            kind: g.kind,
            label: g.label,
            zone: g.zone,
            order_count: !!g.order_count,
            battery_powered: !!g.battery_powered,
            parent_hub_id: g.parent_hub_id,
            online,
            last_seen: row?.last_seen || null,
            last_batch_count: Number(row?.last_batch_count || 0),
            age_seconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
            firmware: row?.firmware || '',
        };
    });
}

function buildPresenceBoard(db, config) {
    if (!config?.enabled) {
        return { enabled: false, message: 'BLE presence is disabled in settings.' };
    }

    const zoneState = recomputeAssetZones(db, config);
    const gateways = getGatewayHealth(db, config);
    const liveAssets = (Array.isArray(zoneState.live_assets) && zoneState.live_assets.length)
        ? zoneState.live_assets
        : db.all(`
        SELECT beacon_id, staff_name, zone_key, zone, gateway_id, rssi, updated_at, asset_type, asset_label, zone_since
        FROM presence_staff_zones
        ORDER BY asset_label, beacon_id
    `);
    const orderHint = getOrderPresenceHint(db, config);
    const offlineGateways = gateways.filter((g) => !g.online);
    const analytics = buildPresenceAnalytics(db, config, { liveAssets, orderHint });

    return {
        enabled: true,
        asset_mode: config.asset_mode,
        asset_mode_label: getAssetModeLabel(config.asset_mode),
        gateways,
        gateways_by_kind: {
            hub: gateways.filter((g) => g.kind === 'hub'),
            aisle: gateways.filter((g) => g.kind === 'aisle'),
            corner: gateways.filter((g) => g.kind === 'corner'),
        },
        live_assets: liveAssets,
        staff_zones: liveAssets,
        order_hint: orderHint,
        analytics,
        alerts: {
            offline_gateways: offlineGateways,
            offline_count: offlineGateways.length,
            unmapped_count: (analytics.unmapped_recent || []).length,
        },
        config_summary: {
            gateway_count: config.gateways.length,
            hub_count: config.hubs?.length || 0,
            aisle_count: config.aisles?.length || 0,
            mapped_badges: Object.keys(config.staff_beacons || {}).length,
            mapped_carts: Object.keys(config.cart_map || {}).length,
            registry: analytics.registry,
            order_gateway_ids: config.order_gateway_ids,
            zone_window_minutes: config.zone_window_minutes,
            stale_minutes: config.stale_minutes,
            allow_discovery: config.allow_discovery,
        },
        architecture: analytics.vision,
    };
}

function snapshotOrderPresence(db, config, { storeDate, orderStart, windowMinutes = 15 } = {}) {
    if (!config?.enabled) return null;
    const hint = getOrderPresenceHint(db, config, { windowMinutes });
    if (!hint) return null;

    const id = `PS-${storeDate}-${Date.now()}`;
    const details = {
        asset_mode: config.asset_mode,
        assets: hint.assets,
        by_gateway: hint.by_gateway,
    };
    db.run(
        `INSERT INTO order_presence_snapshots
         (id, store_date, order_start, snapshot_at, anchor_counts, inferred_staff, staff_names, source, asset_mode, asset_details)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'beacon', ?, ?)`,
        id,
        storeDate,
        orderStart || null,
        new Date().toISOString(),
        JSON.stringify(hint.by_gateway || {}),
        hint.beacon_count,
        JSON.stringify(hint.display_names || hint.staff_names || []),
        config.asset_mode,
        JSON.stringify(details),
    );
    return {
        id,
        inferred_staff: hint.beacon_count,
        staff_names: hint.display_names,
        asset_mode: config.asset_mode,
        by_gateway: hint.by_gateway,
        beacon_count: hint.beacon_count,
        assets: hint.assets,
    };
}

function buildPresenceFinishHint(db, config, typedStaff) {
    if (!config?.enabled) return { hint: null, mismatch: false, message: null };
    const hint = getOrderPresenceHint(db, config);
    if (!hint || hint.beacon_count === 0) {
        return { hint, mismatch: false, message: null };
    }
    const staff = Number(typedStaff);
    const diff = Math.abs(hint.beacon_count - staff);
    const threshold = config.mismatch_threshold || 2;
    const mismatch = diff >= threshold;
    const label = hint.count_label || `~${hint.beacon_count} at receiving`;
    return {
        hint,
        mismatch,
        message: mismatch
            ? `BLE ${label}; you entered ${staff}. Confirm headcount.`
            : null,
    };
}

function buildPresenceExceptions(db, config) {
    if (!config?.enabled) return [];
    const items = [];
    // Read persisted zone rows before board rebuild refreshes updated_at on live sightings.
    let persistedZones = [];
    try {
        persistedZones = db.all(`
            SELECT beacon_id, staff_name, zone_key, zone, gateway_id, rssi, updated_at, asset_type, asset_label
            FROM presence_staff_zones
        `) || [];
    } catch (_) {
        persistedZones = [];
    }
    const board = buildPresenceBoard(db, config);

    getGatewayHealth(db, config)
        .filter((g) => !g.online)
        .forEach((g) => {
            const power = g.battery_powered ? 'battery' : 'USB/mains';
            items.push({
                kind: 'presence_gateway_offline',
                color: '#f44',
                title: g.kind === 'aisle' ? 'AISLE RECEIVER OFFLINE' : 'BLE GATEWAY OFFLINE',
                detail: `${g.label} (${g.id}) — check ${power}`,
                meta: g.last_seen ? `Last seen ${g.last_seen}` : 'Never connected',
            });
        });

    (board.analytics?.unmapped_recent || []).slice(0, 3).forEach((u) => {
        items.push({
            kind: 'presence_unmapped_beacon',
            color: '#8cf',
            title: 'UNMAPPED BLE ASSET',
            detail: `${u.beacon_id} heard ${u.hits}× — register in Presence registry`,
            meta: u.last_seen ? `Last ${u.last_seen}` : '',
        });
    });

    items.push(...buildStaleReceivingCarts(persistedZones, config));

    return items;
}

module.exports = {
    isPresenceEnabled,
    ingestGatewayBatch,
    getOrderPresenceHint,
    buildPresenceBoard,
    snapshotOrderPresence,
    buildPresenceFinishHint,
    buildPresenceExceptions,
    getGatewayHealth,
    getRecentSightings,
    resolveZoneForBeacon,
    recomputeAssetZones,
    recomputeStaffZones: recomputeAssetZones,
};
