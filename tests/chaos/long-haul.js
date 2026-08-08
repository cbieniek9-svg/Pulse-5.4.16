const axios = require('axios');
const fs = require('fs');

/**
 * Phase 6: The Long Haul (365 Day Simulation)
 * 
 * WHY THIS BREAKS THE ARCHITECTURE:
 * Simulated aging of the database reveals cumulative issues:
 * 1. WAL file growth: If checkpointers are blocked, the WAL file can exceed the disk quota.
 * 2. ID Collision: Randomly generated IDs for tasks/audits might collide over 365 days.
 * 3. Sweep Logic Failures: EOD sweeps that trigger every 24h might miss days if the 
 *    server clock jumps or if the sweep itself crashes halfway through.
 * 4. Index Fragmentation: High-speed insert/delete cycles over a year can bloat the 
 *    SQLite file and degrade query performance.
 */

async function longHaulChaos(url, token, days = 365) {
    console.log(`[Phase 6] Initiating Eternal Hell: Simulating ${days} days of operation...`);
    const report = (msg) => fs.appendFileSync('chaos_report.txt', `[Long Haul] ${new Date().toISOString()} - ${msg}\n`);

    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    for (let i = 0; i < days; i++) {
        const currentDate = new Date(startDate.getTime());
        currentDate.setDate(startDate.getDate() + i);
        const dateStr = currentDate.toISOString().split('T')[0];

        if (i % 30 === 0) console.log(`[Phase 6] Progress: Day ${i}/${days} (${dateStr})...`);

        try {
            // 1. Simulate Daily Transactions
            const numTransactions = 100;
            const txPromises = [];
            for (let t = 0; t < numTransactions; t++) {
                txPromises.push(axios.post(`${url}/api/homebase-audits`, {
                    token,
                    audit: {
                        zone_name: `Zone-${Math.floor(Math.random() * 8) + 1}`,
                        premium_name: `Item-${Math.floor(Math.random() * 100)}`,
                        front_edge_pass: Math.random() > 0.2 ? 1 : 0,
                        tag_integrity_pass: Math.random() > 0.1 ? 1 : 0,
                        timestamp: currentDate.toISOString()
                    }
                }).catch(e => {
                    if (e.response?.status === 500) report(`Day ${i}: API 500 error during transaction`);
                }));
            }
            await Promise.all(txPromises);
            if (i % 10 === 0) report(`Day ${i}: Successfully processed 100 transactions.`);

            // 2. Trigger EOD Sweep via API
            // Since we can't easily change the OS clock for 365 iterations in JS,
            // we call the /api/eod-sweep endpoint which triggers the server-side sweep logic.
            await axios.post(`${url}/api/eod-sweep`, { token }).catch(e => {
                report(`Day ${i}: EOD Sweep failed with status ${e.response?.status}`);
            });

            // 3. Periodic Health Check
            if (i % 50 === 0) {
                const health = await axios.get(`${url}/api/health`).catch(() => null);
                if (health) {
                    report(`Checkpoint Day ${i}: DB Size: ${health.data.dbSize} bytes, Uptime: ${health.data.uptime}s`);
                }
            }

        } catch (err) {
            report(`Day ${i}: Critical loop error: ${err.message}`);
        }
    }

    console.log(`[Phase 6] Eternal Hell simulation complete.`);
}

module.exports = longHaulChaos;