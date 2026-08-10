'use strict';
/**
 * Dev/test helper: POST synthetic BLE batches to a running Command Center.
 *
 *   set PRESENCE_GATEWAY_KEY=<key>
 *   node scripts/presence-gateway-simulator.cjs --url http://127.0.0.1:3000 --gateway GW-RECV
 */
const http = require('http');
const https = require('https');

function parseArgs(argv) {
    const out = {
        url: 'http://127.0.0.1:3000',
        gateway: 'GW-RECV',
        count: 2,
    };
    for (let i = 2; i < argv.length; i += 1) {
        const a = argv[i];
        if (a === '--url') out.url = argv[++i];
        else if (a === '--gateway') out.gateway = argv[++i];
        else if (a === '--count') out.count = Number(argv[++i]) || 2;
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

async function main() {
    const args = parseArgs(process.argv);
    const key = String(process.env.PRESENCE_GATEWAY_KEY || '').trim();
    if (!key) {
        console.error('Missing PRESENCE_GATEWAY_KEY (Presence_Gateway_Key from manager config)');
        process.exit(1);
    }

    const seen = [];
    for (let i = 0; i < args.count; i += 1) {
        seen.push({
            beacon_id: `sim:beacon:${i + 1}`,
            rssi: -58 - i * 3,
        });
    }

    const res = await postJson(args.url, '/api/presence/ingest', {
        gateway_id: args.gateway,
        firmware: 'simulator/1.0',
        seen,
    }, { 'X-Presence-Gateway-Key': key });

    console.log(res.status, res.body);
    if (res.status >= 400) process.exit(1);
}

main().catch((e) => {
    console.error(e.message);
    process.exit(1);
});
