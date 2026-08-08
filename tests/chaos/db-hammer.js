const axios = require('axios');
const fs = require('fs');

/**
 * Phase 2: Database Hammer & Transaction Tearing
 *
 * WHY THIS BREAKS THE ARCHITECTURE:
 * SQLite in WAL (Write-Ahead Logging) mode allows multiple readers, but only ONE writer.
 * Firing 1,000 parallel asynchronous POST requests hitting the exact same endpoint
 * forces better-sqlite3 to queue transactions. If the transaction processing takes
 * too long (e.g., due to our massive 10MB payload) or throws an error halfway through
 * (due to our malformed arrays/SQL injections), it forces a rollback.
 * Under extreme load, SQLite may hit its busy_timeout and throw a SQLITE_BUSY error,
 * causing lost writes. This phase explicitly tests if the Express backend isolates
 * the database queue properly without corrupting the file or leaving partial writes.
 */
async function hammerDB(url, token, count = 2000) {
    console.log(`[Phase 2] Initiating DB Hammer: ${count} concurrent audits...`);

    // Massive 10MB Payload
    const largeString = "A".repeat(10 * 1024 * 1024);

    const maliciousPayloads = [
        { zone_name: "A1", audit_data: "Baseline overlap 1" },
        { zone_name: "A1", audit_data: "Baseline overlap 2" },
        // Memory & Transaction bloat
        { zone_name: "A2", audit_data: largeString },
        // Schema corruption attempt: nested arrays where strings are expected
        { zone_name: "A3", audit_data: [[["nested"]]], notes: ["Not", "a", "string"] },
        // SQL Injection attempts in JSON keys
        { "zone_name'; DROP TABLE audits; --": "A4", "audit_data": "Injected key" },
        { zone_name: "A5", "audit_data') OR 1=1; --": "SQL injection" }
    ];

    const promises = [];

    for (let i = 0; i < count; i++) {
        const payload = maliciousPayloads[i % maliciousPayloads.length];

        // MIXED LOAD: Complexity Increase (Add GETs while hammering)
        if (i % 10 === 0) {
            promises.push(axios.get(`${url}/api/sync?token=${token}`).catch(() => {}));
        }

        const req = axios.post(`${url}/api/homebase-audits`, 

            { token, audit: payload },
            {
                headers: { 'Content-Type': 'application/json' },
                maxBodyLength: Infinity,
                timeout: 10000 // Force timeouts if queue gets stuck
            }
        ).catch(err => {
            const errInfo = err.response?.data || err.message;
            const status = err.response?.status || 500;
            const errString = typeof errInfo === 'object' ? JSON.stringify(errInfo) : errInfo;

            const entry = `[Database Locks] ${new Date().toISOString()} - POST /homebase-audits - Status: ${status} - Error: ${errString}\n`;
            fs.appendFileSync('chaos_report.txt', entry);

            // Log exact payload on internal/DB failures
            if (status === 500 || errString.includes('SQLITE_BUSY') || errString.includes('SQLITE_CORRUPT') || errString.includes('Transaction Rolled Back')) {
                fs.appendFileSync('chaos_report.txt', `[Autopsy] DB Hammer Payload that caused 500/Lock:\n${JSON.stringify(payload).substring(0, 500)}...\n`);
            }
        });
        promises.push(req);
    }

    // Fire them all at the exact same millisecond
    await Promise.all(promises);
    console.log(`[Phase 2] DB Hammer complete.`);
}
module.exports = hammerDB;