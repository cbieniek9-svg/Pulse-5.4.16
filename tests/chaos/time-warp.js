const fs = require('fs');
const axios = require('axios');

/**
 * Phase 4: Time Travel & State Corruption
 * 
 * WHY THIS BREAKS THE ARCHITECTURE:
 * node-cron relies on system time. If a long-running DB transaction is writing exactly 
 * when the clock strikes 23:59 (EOD Sweep), both the transaction and the sweep will 
 * try to write to the WAL simultaneously. 
 * Furthermore, triggering db.backup() natively during an active WAL write can result 
 * in copying an incomplete/corrupted file if PRAGMA settings aren't strictly locking it.
 * Finally, abrupt killing and jumping time tests if the app's 'catchUpMissedSweeps' 
 * gracefully identifies the gap on reboot without duplicating aggregate data.
 */
async function timeWarp(url) {
    console.log(`[Phase 4] Initiating Time Travel & State Corruption...`);
    const report = (msg) => fs.appendFileSync('chaos_report.txt', `[Time Warp / State] ${new Date().toISOString()} - ${msg}\n`);

    try {
        // Start a massive audit transaction to keep DB open
        const largeString = "A".repeat(5 * 1024 * 1024);
        report("Starting heavy DB transaction...");
        const pendingRequest = axios.post(`${url}/api/homebase-audits`, {
            token: "CHAOS_TOKEN",
            audit: { zone_name: "TimeWarp", audit_data: largeString }
        });

        // 1. Clock Manipulation Simulation
        report("Simulating immediate fast-forward to 23:59 (triggering EOD Sweep during write)...");
        // In a real environment, this requires OS level clock change. 
        // We log the manual/infrastructure hook requirement here.
        
        // 2. Backup Corruption Test
        report("Triggering native db.backup() simulation during active transaction...");
        try {
            // Attempt file copy while WAL is active
            fs.copyFileSync('../tgp_ops.db', '../tgp_ops_corrupt_test.db');
            report("Backup simulation copied DB during write.");
        } catch (e) {
            report(`Backup simulation rejected (Expected if locked properly): ${e.message}`);
        }

        await pendingRequest.catch(() => {});

        // 3. Server Kill & 48h Advance
        report("ACTION REQUIRED: Kill server abruptly (SIGKILL). Fast-forward OS clock 48 hours. Reboot server.");
        report("Verify 'catchUpMissedSweeps' repairs missed days without duplicating data.");
        
    } catch (e) {
        report(`Script Error during time warp setup: ${e.message}`);
    }
}

module.exports = timeWarp;