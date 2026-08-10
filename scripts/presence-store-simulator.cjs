'use strict';
/**
 * Ultimate dev simulator: smart carts + dumb aisle receivers → receiving hub.
 *
 *   set PRESENCE_GATEWAY_KEY=<key>
 *   node scripts/presence-store-simulator.cjs --url http://127.0.0.1:3001 --ticks 5
 *
 * Requires Presence_Enabled=1 and demo carts seeded (or uses cart-001..008).
 */
const http = require('http');
const https = require('https');

function parseArgs(argv) {
    const out = {
        url: 'http://127.0.0.1:3001',
        ticks: 3,
        carts: 6,
        aisles: 4,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--url') out.url = argv[++i];
        else if (a === '--ticks') out.ticks = Number(argv[++i]) || 3;
        else if (a === '--carts') out.carts = Number(argv[++i]) || 6;
        else if (a === '--aisles') out.aisles = Number(argv[++i]) || 4;
        else if (a === '--key') {
            console.error('Rejecting --key. Set PRESENCE_GATEWAY_KEY in the environment instead.');
            process.exit(1);
        }
    }
    return out;
}

function postJson(baseUrl, path, body, headers) {
    const u = new URL(path, baseUrl);
    const lib = u.protocol === 'https:' ? https : http;
    const payload = JSON.stringify(body);
    return new Promise((resolve, reject) => {
        const req = lib.request({
            hostname: u.hostname,
            port: u.port || (u.protocol === 'https:' ? 443 : 80),
            path: u.pathname,
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(payload),
                ...headers,
            },
        }, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
                catch (_) { resolve({ status: res.statusCode, body: data }); }
            });
        });
        req.on('error', reject);
        req.write(payload);
        req.end();
    });
}

function pickAisle(i, maxAisles) {
    const n = (i % maxAisles) + 1;
    return `AISLE-A${String(n).padStart(2, '0')}`;
}

async function main() {
    const args = parseArgs(process.argv);
    const key = String(process.env.PRESENCE_GATEWAY_KEY || '').trim();
    if (!key) {
        console.error('Missing PRESENCE_GATEWAY_KEY');
        process.exit(1);
    }

    const headers = { 'X-Presence-Gateway-Key': key };

    for (let t = 0; t < args.ticks; t += 1) {
        const forwarded = [];
        for (let i = 0; i < args.aisles; i += 1) {
            const aisle = pickAisle(i + t, 12);
            const cartIdx = (i + t) % args.carts;
            forwarded.push({
                gateway_id: aisle,
                firmware: 'aisle-sim/1.0',
                seen: [{
                    beacon_id: `cart-${String(cartIdx + 1).padStart(3, '0')}`,
                    rssi: -68 - i * 2,
                }],
            });
        }

        const recvCarts = [];
        for (let c = 0; c < Math.min(3, args.carts); c += 1) {
            recvCarts.push({
                beacon_id: `cart-${String(c + 1).padStart(3, '0')}`,
                rssi: -55 - c,
            });
        }

        const body = {
            gateway_id: 'GW-RECV',
            firmware: 'hub-sim/1.0',
            seen: recvCarts,
            forwarded,
        };

        const res = await postJson(args.url, '/api/presence/ingest', body, headers);
        console.log(`tick ${t + 1}/${args.ticks}`, res.status, res.body?.batches != null ? `${res.body.batches} batches` : res.body);
        if (res.status >= 400) process.exit(1);
        await new Promise((r) => setTimeout(r, 800));
    }

    console.log('Done — open Manager → Exception Inbox for live presence board.');
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
