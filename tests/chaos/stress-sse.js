const EventSource = require('eventsource');
const axios = require('axios');
const fs = require('fs');

/**
 * Phase 1: The Thundering Herd (Network & SSE Stress)
 *
 * Uses the production stream-token exchange (/api/stream-token → ?st=…) rather than
 * passing session tokens in the EventSource URL.
 */
async function fetchStreamUrl(baseUrl, sessionToken) {
    const { data, status } = await axios.post(
        `${baseUrl}/api/stream-token`,
        { token: sessionToken },
        { headers: { 'Content-Type': 'application/json' }, validateStatus: () => true },
    );
    if (status !== 200 || !data?.streamToken) {
        throw new Error(`stream-token failed (${status})`);
    }
    return `${baseUrl}/api/stream?st=${encodeURIComponent(data.streamToken)}`;
}

async function openStream(baseUrl, sessionToken) {
    const url = await fetchStreamUrl(baseUrl, sessionToken);
    return new EventSource(url);
}

async function stressSSE(url, token, count = 500) {
    console.log(`[Phase 1] Initiating Thundering Herd: ${count} SSE clients...`);
    const clients = [];

    console.log(`[Phase 1] Adding 100 Zombie Clients (hang open, no data read)...`);
    for (let i = 0; i < 100; i++) {
        try {
            const es = await openStream(url, token);
            clients.push(es);
        } catch (err) {
            fs.appendFileSync('chaos_report.txt', `[SSE Disconnects] ${new Date().toISOString()} - Zombie connect failed: ${err.message}\n`);
        }
    }

    return new Promise((resolve) => {
        let openCount = 0;
        clients.forEach((es) => {
            es.onopen = () => {
                openCount++;
                if (openCount === clients.length && clients.length > 0) {
                    console.log(`[Phase 1] ${openCount} clients connected. Initiating Router Crash Simulation...`);

                    clients.forEach((c) => c.close());
                    fs.appendFileSync('chaos_report.txt', `[SSE Disconnects] ${new Date().toISOString()} - Force-dropped ${openCount} connections to trigger reconnect surge.\n`);

                    console.log(`[Phase 1] Simulating Thundering Herd reconnect surge...`);
                    const reconnectClients = [];
                    for (let j = 0; j < count; j++) {
                        const jitter = Math.random() * 500;
                        setTimeout(async () => {
                            try {
                                const newEs = await openStream(url, token);
                                newEs.onerror = (err) => {
                                    fs.appendFileSync('chaos_report.txt', `[SSE Disconnects] ${new Date().toISOString()} - Surge reconnect failed: ${err.message || 'Connection refused'}\n`);
                                };
                                reconnectClients.push(newEs);
                            } catch (err) {
                                fs.appendFileSync('chaos_report.txt', `[SSE Disconnects] ${new Date().toISOString()} - Surge token exchange failed: ${err.message}\n`);
                            }
                        }, jitter);
                    }

                    setTimeout(() => {
                        reconnectClients.forEach((c) => c.close());
                        resolve();
                    }, 10000);
                }
            };
            es.onerror = (err) => {
                fs.appendFileSync('chaos_report.txt', `[SSE Disconnects] ${new Date().toISOString()} - Connection error during ramp-up: ${err.message || 'Connection Refused'}\n`);
            };
        });

        setTimeout(() => {
            if (openCount < clients.length) {
                console.log(`[Phase 1] Could not connect all clients (${openCount}/${clients.length}). Resolving early.`);
                resolve();
            }
        }, 15000);
    });
}

module.exports = stressSSE;
