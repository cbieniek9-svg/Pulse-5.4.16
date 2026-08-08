const stressSSE = require('./stress-sse');
const hammerDB = require('./db-hammer');
const timeWarp = require('./time-warp');
const longHaul = require('./long-haul');
const fs = require('fs');
const { execSync } = require('child_process');

/**
 * ETERNAL HELL MODE ORCHESTRATOR
 * This executes all Chaos Phases including the 365-day Long Haul.
 */

const API_URL = 'http://localhost:3001';
const TEST_TOKEN = 'CHAOS_TEST_TOKEN';

// Setup Mock Session (since we are running in the same process tree or can reach the global)
// In a real scenario, we'd use a seed script or a back-door for testing.
// For this environment, we'll simulate the token being valid if it matches our secret.
async function runHellInfinity() {
    console.log("🔥 TGP COMMAND CENTER V2: ETERNAL HELL MODE ACTIVATED 🔥");
    fs.writeFileSync('chaos_report.txt', `--- CHAOS REPORT: ${new Date().toLocaleString()} ---\n\n`);

    try {
        // Phase 1
        await stressSSE(API_URL, TEST_TOKEN, 500);

        // Phase 2
        await hammerDB(API_URL, TEST_TOKEN, 2000);

        // Phase 6: Eternal Hell (Complexity + Time)
        await longHaul(API_URL, TEST_TOKEN, 365);

        // Phase 4
        await timeWarp(API_URL);

        // Phase 3 & 5 (Playwright UI Chaos + Tracing)
        console.log("\n[Phase 3] Launching Playwright UI Gremlin...");
        try {
            execSync('npx playwright test ui-gremlin.spec.js', { stdio: 'inherit' });
        } catch (pwError) {
            console.log("Playwright tests generated failures (expected in Chaos mode). Traces captured.");
        }

        console.log("\n[CHAOS] Execution Complete. Review chaos_report.txt and Playwright traces for the final autopsy.");
    } catch (e) {
        fs.appendFileSync('chaos_report.txt', `[FATAL] Suite crashed: ${e.message}\n`);
        console.error("Fatal error during chaos run:", e);
    }
}

runHellInfinity();