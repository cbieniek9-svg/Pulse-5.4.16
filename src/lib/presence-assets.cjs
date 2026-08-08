'use strict';

const ASSET_TYPES = ['staff', 'cart', 'badge', 'unknown'];

function lookupStaffFromConfig(config, beaconId) {
    const key = normalizeBeaconId(beaconId);
    const map = config?.staff_beacons || {};
    for (const [uuid, name] of Object.entries(map)) {
        if (normalizeBeaconId(uuid) === key) return String(name).trim();
    }
    return null;
}

function normalizeBeaconId(id) {
    return String(id || '').trim().toLowerCase();
}

function inferAssetType(beaconId, config, row) {
    if (row?.asset_type && ASSET_TYPES.includes(row.asset_type)) return row.asset_type;
    const bid = normalizeBeaconId(beaconId);
    if (!bid) return 'unknown';
    if (bid.startsWith('cart-') || bid.startsWith('cart:')) return 'cart';
    if (config?.staff_beacons && Object.keys(config.staff_beacons).some((k) => normalizeBeaconId(k) === bid)) {
        return 'badge';
    }
    const cartMap = config?.cart_map || {};
    if (Object.keys(cartMap).some((k) => normalizeBeaconId(k) === bid)) return 'cart';
    return 'unknown';
}

function resolveAsset(db, config, beaconId) {
    const bid = normalizeBeaconId(beaconId);
    const row = db.get('SELECT * FROM presence_assets WHERE beacon_id = ?', bid);
    const assetType = inferAssetType(bid, config, row);
    const staffFromBadge = lookupStaffFromConfig(config, bid);
    const label = row?.label
        || (config?.cart_map?.[bid])
        || (config?.cart_map?.[Object.keys(config?.cart_map || {}).find((k) => normalizeBeaconId(k) === bid)])
        || staffFromBadge
        || (assetType === 'cart' ? bid.replace(/^cart[-:]/, 'Cart ').toUpperCase() : null);

    return {
        beacon_id: bid,
        asset_type: assetType,
        asset_label: label || bid,
        staff_name: row?.default_staff || staffFromBadge || null,
        aisle_hint: row?.aisle_hint || null,
        active: row?.active !== 0,
        registered: !!row,
    };
}

function assetMatchesMode(asset, mode) {
    if (mode === 'both') return asset.asset_type === 'cart' || asset.asset_type === 'badge' || asset.asset_type === 'staff';
    if (mode === 'cart') return asset.asset_type === 'cart';
    if (mode === 'staff') return asset.asset_type === 'badge' || asset.asset_type === 'staff';
    return true;
}

function listAssets(db, { activeOnly = true, type = null } = {}) {
    let sql = 'SELECT * FROM presence_assets';
    const clauses = [];
    const params = [];
    if (activeOnly) clauses.push('active = 1');
    if (type) {
        clauses.push('asset_type = ?');
        params.push(type);
    }
    if (clauses.length) sql += ` WHERE ${clauses.join(' AND ')}`;
    sql += ' ORDER BY asset_type, label, beacon_id';
    return db.all(sql, ...params);
}

function upsertAsset(db, {
    beacon_id,
    asset_type = 'cart',
    label,
    aisle_hint,
    default_staff,
    active = 1,
    notes,
}) {
    const bid = normalizeBeaconId(beacon_id);
    if (!bid) throw Object.assign(new Error('beacon_id required'), { status: 400 });
    const now = new Date().toISOString();
    const existing = db.get('SELECT beacon_id FROM presence_assets WHERE beacon_id = ?', bid);
    if (existing) {
        db.run(
            `UPDATE presence_assets SET asset_type=?, label=?, aisle_hint=?, default_staff=?, active=?, notes=?, updated_at=?
             WHERE beacon_id=?`,
            asset_type,
            label || null,
            aisle_hint || null,
            default_staff || null,
            active ? 1 : 0,
            notes || null,
            now,
            bid,
        );
    } else {
        db.run(
            `INSERT INTO presence_assets
             (beacon_id, asset_type, label, aisle_hint, default_staff, active, notes, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            bid,
            asset_type,
            label || null,
            aisle_hint || null,
            default_staff || null,
            active ? 1 : 0,
            notes || null,
            now,
            now,
        );
    }
    return { beacon_id: bid, updated_at: now };
}

function deleteAsset(db, beaconId) {
    const bid = normalizeBeaconId(beaconId);
    db.run('DELETE FROM presence_assets WHERE beacon_id = ?', bid);
}

function seedCartsFromMap(db, cartMap) {
    if (!cartMap || typeof cartMap !== 'object') return 0;
    let n = 0;
    Object.entries(cartMap).forEach(([uuid, label]) => {
        upsertAsset(db, {
            beacon_id: uuid,
            asset_type: 'cart',
            label: String(label).trim(),
        });
        n += 1;
    });
    return n;
}

module.exports = {
    ASSET_TYPES,
    normalizeBeaconId,
    inferAssetType,
    resolveAsset,
    assetMatchesMode,
    listAssets,
    upsertAsset,
    deleteAsset,
    seedCartsFromMap,
};
