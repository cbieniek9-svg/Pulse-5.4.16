'use strict';

const crypto = require('crypto');
const {
    loadPresenceConfig,
    savePresenceSettings,
    SETTING_GATEWAY_KEY,
    ASSET_MODES,
    TEMPLATE_AISLE_GATEWAYS,
} = require('../lib/presence-config.cjs');
const { ingestGatewayBatch, buildPresenceBoard } = require('../lib/presence-engine.cjs');
const { buildPresenceReportSummary } = require('../lib/presence-reports.cjs');
const { listAssets, upsertAsset, deleteAsset, seedCartsFromMap } = require('../lib/presence-assets.cjs');

function extractGatewayKey(req) {
    const header = req.header('x-presence-gateway-key') || req.header('X-Presence-Gateway-Key');
    if (header) return String(header).trim();
    const body = req.body?.gateway_key;
    if (body) return String(body).trim();
    return '';
}

function requireGatewayKey(req, res, config) {
    const key = extractGatewayKey(req);
    if (!config.gateway_key || key !== config.gateway_key) {
        res.status(401).json({ error: 'Invalid or missing gateway key' });
        return false;
    }
    return true;
}

function maskKey(key) {
    const s = String(key || '');
    if (s.length < 8) return '********';
    return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

function registerPresenceRoutes(server, ctx) {
    const { wrap, fail, requireSession, db, broadcastUpdate } = ctx;

    server.post('/api/presence/ingest', wrap(async (req, res) => {
        const config = loadPresenceConfig(db);
        if (!config.enabled) {
            return res.json({ accepted: false, reason: 'Presence_Enabled is off' });
        }
        if (!requireGatewayKey(req, res, config)) return;

        const b = req.body ?? {};
        const results = [];
        try {
            if (Array.isArray(b.forwarded) && b.forwarded.length) {
                const hubId = b.gateway_id || config.hubs?.[0]?.id || 'GW-RECV';
                b.forwarded.forEach((chunk) => {
                    results.push(ingestGatewayBatch(db, {
                        gateway_id: chunk.gateway_id,
                        seen: chunk.seen || chunk.beacons || [],
                        firmware: chunk.firmware,
                        recorded_at: chunk.recorded_at,
                        relayed_by: hubId,
                    }, config));
                });
            }
            if (b.gateway_id || (b.seen || b.beacons || []).length) {
                results.push(ingestGatewayBatch(db, {
                    gateway_id: b.gateway_id || config.hubs?.[0]?.id,
                    seen: b.seen || b.beacons || [],
                    firmware: b.firmware,
                    recorded_at: b.recorded_at,
                }, config));
            }
            broadcastUpdate();
            res.json({
                accepted: true,
                batches: results.length,
                results,
            });
        } catch (e) {
            return fail(res, e.status || 400, e.message || 'Ingest failed');
        }
    }));

    server.get('/api/presence/board', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const config = loadPresenceConfig(db);
        res.json(buildPresenceBoard(db, config));
    }));

    server.get('/api/presence/config', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const config = loadPresenceConfig(db);
        res.json({
            enabled: config.enabled,
            gateway_key_masked: maskKey(config.gateway_key),
            asset_mode: config.asset_mode,
            asset_modes: ASSET_MODES,
            gateways: config.gateways,
            template_aisle_gateways: TEMPLATE_AISLE_GATEWAYS,
            staff_beacons: config.staff_beacons,
            cart_map: config.cart_map,
            order_gateway_ids: config.order_gateway_ids,
            stale_minutes: config.stale_minutes,
            zone_window_minutes: config.zone_window_minutes,
            rssi_floor: config.rssi_floor,
            allow_discovery: config.allow_discovery,
            mismatch_threshold: config.mismatch_threshold,
            architecture: {
                smart: 'Carts carry BLE beacon ID',
                dumb: 'Aisle receivers (battery) scan and relay',
                hub: 'GW-RECV USB hub posts to TGP',
            },
        });
    }));

    server.post('/api/presence/config', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const b = req.body ?? {};
        if (b.enabled != null) {
            db.run(
                'INSERT OR REPLACE INTO settings (setting_name, setting_value) VALUES (?, ?)',
                'Presence_Enabled',
                b.enabled ? '1' : '0',
            );
        }
        savePresenceSettings(db, {
            gateways: b.gateways,
            staff_beacons: b.staff_beacons,
            cart_map: b.cart_map,
            order_gateway_ids: b.order_gateway_ids,
            stale_minutes: b.stale_minutes,
            zone_window_minutes: b.zone_window_minutes,
            rssi_floor: b.rssi_floor,
            asset_mode: b.asset_mode,
            allow_discovery: b.allow_discovery,
            mismatch_threshold: b.mismatch_threshold,
        });
        broadcastUpdate();
        const config = loadPresenceConfig(db);
        res.json({ success: true, board: buildPresenceBoard(db, config) });
    }));

    server.post('/api/presence/rotate-key', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const key = crypto.randomBytes(16).toString('hex');
        db.run(
            'INSERT OR REPLACE INTO settings (setting_name, setting_value) VALUES (?, ?)',
            SETTING_GATEWAY_KEY,
            key,
        );
        res.json({ success: true, gateway_key: key });
    }));

    server.get('/api/presence/assets', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const type = req.query.type || null;
        res.json({ assets: listAssets(db, { activeOnly: req.query.all !== '1', type }) });
    }));

    server.post('/api/presence/assets', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const b = req.body ?? {};
        try {
            const row = upsertAsset(db, b);
            broadcastUpdate();
            res.json({ success: true, asset: row });
        } catch (e) {
            return fail(res, e.status || 400, e.message);
        }
    }));

    server.delete('/api/presence/assets/:beaconId', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        deleteAsset(db, req.params.beaconId);
        broadcastUpdate();
        res.json({ success: true });
    }));

    server.post('/api/presence/seed-demo-carts', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const count = Math.min(24, Math.max(1, Number(req.body?.count) || 8));
        const carts = {};
        for (let i = 1; i <= count; i += 1) {
            const id = `cart-${String(i).padStart(3, '0')}`;
            carts[id] = `Cart ${i}`;
            upsertAsset(db, { beacon_id: id, asset_type: 'cart', label: `Cart ${i}` });
        }
        savePresenceSettings(db, { cart_map: carts });
        broadcastUpdate();
        res.json({ success: true, count, cart_map: carts });
    }));

    server.post('/api/presence/enable-aisle-template', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const config = loadPresenceConfig(db);
        const enabled = TEMPLATE_AISLE_GATEWAYS.map((g) => ({ ...g, enabled: true }));
        const merged = config.gateways
            .filter((g) => !g.id.startsWith('AISLE-'))
            .concat(enabled);
        savePresenceSettings(db, { gateways: merged, allow_discovery: true });
        broadcastUpdate();
        res.json({ success: true, aisle_count: enabled.length });
    }));

    server.get('/api/presence/report-summary', wrap(async (req, res) => {
        const session = requireSession(req, res, true);
        if (!session) return;
        const config = loadPresenceConfig(db);
        const reportDate = req.query.date || new Date().toISOString().slice(0, 10);
        res.json(buildPresenceReportSummary(db, config, {
            reportDate,
            isLiveToday: reportDate === new Date().toISOString().slice(0, 10),
        }));
    }));
}

module.exports = { registerPresenceRoutes };
