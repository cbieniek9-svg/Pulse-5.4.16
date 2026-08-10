'use strict';

const { resolveAsset, assetMatchesMode } = require('./presence-assets.cjs');
const { getAssetModeLabel } = require('./presence-config.cjs');

function buildZoneOccupancy(liveAssets) {
    const byZone = {};
    (liveAssets || []).forEach((a) => {
        const zk = a.zone_key || 'Unknown';
        byZone[zk] = (byZone[zk] || 0) + 1;
    });
    return Object.entries(byZone)
        .map(([zone_key, count]) => ({ zone_key, zone: liveAssets.find((x) => x.zone_key === zone_key)?.zone || zone_key, count }))
        .sort((a, b) => b.count - a.count);
}

function buildGatewayRollup(db, config, { sinceMinutes = 60 } = {}) {
    const since = new Date(Date.now() - sinceMinutes * 60000).toISOString();
    const rows = db.all(`
        SELECT gateway_id, COUNT(*) as sightings, COUNT(DISTINCT beacon_id) as unique_assets
        FROM beacon_events
        WHERE recorded_at >= ?
        GROUP BY gateway_id
        ORDER BY sightings DESC
    `, since);
    return rows.map((r) => {
        const gw = config.gateway_by_id[r.gateway_id];
        return {
            gateway_id: r.gateway_id,
            label: gw?.label || r.gateway_id,
            kind: gw?.kind || 'unknown',
            sightings: Number(r.sightings || 0),
            unique_assets: Number(r.unique_assets || 0),
        };
    });
}

function buildUnmappedSightings(db, config, { sinceMinutes = 30, limit = 10 } = {}) {
    const since = new Date(Date.now() - sinceMinutes * 60000).toISOString();
    const rows = db.all(`
        SELECT beacon_id, MAX(recorded_at) as last_seen, MAX(rssi) as best_rssi, COUNT(*) as hits
        FROM beacon_events
        WHERE recorded_at >= ?
        GROUP BY beacon_id
        ORDER BY last_seen DESC
        LIMIT ?
    `, since, limit);
    return rows
        .map((r) => {
            const asset = resolveAsset(db, config, r.beacon_id);
            return {
                beacon_id: r.beacon_id,
                last_seen: r.last_seen,
                best_rssi: r.best_rssi,
                hits: Number(r.hits || 0),
                asset_type: asset.asset_type,
                registered: asset.registered,
                asset_label: asset.asset_label,
            };
        })
        .filter((r) => !r.registered && r.asset_type === 'unknown');
}

/** Prefer persisted presence_staff_zones rows — refreshed live_assets bump updated_at. */
function buildStaleReceivingCarts(zoneRows, config, { staleMinutes = 45 } = {}) {
    if (config.asset_mode === 'staff') return [];
    const cutoff = Date.now() - staleMinutes * 60000;
    return (zoneRows || [])
        .filter((a) => a.asset_type === 'cart' && a.zone_key === 'Receiving')
        .filter((a) => a.updated_at && Date.parse(a.updated_at) < cutoff)
        .map((a) => ({
            kind: 'presence_stale_cart_receiving',
            color: '#fa0',
            title: 'CART IDLE IN RECEIVING',
            detail: `${a.asset_label} (${a.beacon_id}) — ${Math.round((Date.now() - Date.parse(a.updated_at)) / 60000)}m`,
            meta: 'Park carts or check for abandoned hardware',
        }));
}

function buildPresenceAnalytics(db, config, { liveAssets = [], orderHint = null } = {}) {
    const registry = {
        carts: 0,
        badges: 0,
        unknown: 0,
    };
    try {
        db.all('SELECT asset_type, COUNT(*) as c FROM presence_assets WHERE active = 1 GROUP BY asset_type')
            .forEach((r) => {
                if (r.asset_type === 'cart') registry.carts = Number(r.c);
                else if (r.asset_type === 'badge') registry.badges = Number(r.c);
            });
    } catch (_) {
        registry.carts = Object.keys(config.cart_map || {}).length;
        registry.badges = Object.keys(config.staff_beacons || {}).length;
    }

    return {
        asset_mode: config.asset_mode,
        asset_mode_label: getAssetModeLabel(config.asset_mode),
        zone_occupancy: buildZoneOccupancy(liveAssets),
        gateway_rollup_1h: buildGatewayRollup(db, config, { sinceMinutes: 60 }),
        unmapped_recent: buildUnmappedSightings(db, config),
        registry,
        order_hint_summary: orderHint ? {
            count: orderHint.beacon_count,
            label: orderHint.count_label,
            names: orderHint.display_names,
        } : null,
        vision: {
            smart: 'Cart broadcasts BLE ID (battery tag on cart frame)',
            dumb: 'Aisle receivers scan + forward to GW-RECV hub (battery, no WiFi)',
            hub: 'Receiving controller posts batches to TGP Center Store',
        },
    };
}

function enrichOrderHint(hint, config) {
    if (!hint) return null;
    const mode = config.asset_mode;
    const label = getAssetModeLabel(mode);
    const filtered = (hint.assets || []).filter((a) => assetMatchesMode(a, mode));
    return {
        ...hint,
        beacon_count: filtered.length,
        count_label: `~${filtered.length} ${label} at receiving`,
        display_names: filtered.map((a) => a.asset_label || a.staff_name).filter(Boolean),
        assets: filtered,
    };
}

module.exports = {
    buildZoneOccupancy,
    buildGatewayRollup,
    buildUnmappedSightings,
    buildStaleReceivingCarts,
    buildPresenceAnalytics,
    enrichOrderHint,
};
