const { test, expect } = require('@playwright/test');
const fs = require('fs');

/**
 * Phase 3: The Gremlin (UI Chaos Monkey)
 * 
 * WHY THIS BREAKS THE ARCHITECTURE:
 * Human timing hides frontend race conditions. By executing 100 clicks in 2 seconds, 
 * we force React/Vanilla JS state updates to collide. If the "15M RECOVERY" button 
 * doesn't have debounce or disabled-state logic, it will queue 100 API calls, 
 * triggering database locks.
 * Throttling the network while submitting fuzzed payloads (null bytes, emojis, RTL) 
 * tests if the UI gracefully handles multi-submit race conditions and if the backend 
 * sanitizers crash on wide characters/null terminators.
 */
test.describe('Hell Infinity - UI Chaos Monkey', () => {
    
    test.beforeEach(async ({ page }) => {
        // Phase 5: The Autopsy - Granular Error Logging & Tracing
        page.on('console', msg => {
            if (msg.type() === 'error') {
                fs.appendFileSync('chaos_report.txt', `[UI Race Conditions/Browser Errors] ${new Date().toISOString()} - ${msg.text()}\n`);
            }
        });

        page.on('requestfailed', request => {
            fs.appendFileSync('chaos_report.txt', `[Network Drops] ${new Date().toISOString()} - ${request.url()} - ${request.failure().errorText}\n`);
        });

        page.on('response', async response => {
            if (response.status() >= 400) {
                const req = response.request();
                let body = await req.postData();
                fs.appendFileSync('chaos_report.txt', `[API Failures] ${new Date().toISOString()} - ${req.method()} ${req.url()} - Status: ${response.status()}\nHeaders: ${JSON.stringify(req.headers())}\nBody: ${body}\n`);
            }
        });
    });

    test('Rapid Surge Button Spam & Race Conditions', async ({ page }) => {
        // Note: Assuming auto-login in test environment
        await page.goto('/');
        
        console.log("[Phase 3] Spamming 15M RECOVERY button...");
        const recoveryBtn = page.getByText('⚡ 15M RECOVERY');
        
        // Wait for it to be visible
        try {
            await recoveryBtn.waitFor({ state: 'visible', timeout: 5000 });
            
            // Hell Infinity Mode: 100 clicks in 2s ignoring human timing
            const clickPromises = [];
            for (let i = 0; i < 100; i++) {
                clickPromises.push(recoveryBtn.click({ force: true, noWaitAfter: true }).catch(() => {}));
            }
            await Promise.all(clickPromises);
        } catch (e) {
            console.log("Button not found, moving on.");
        }
    });

    test('Audit Form Fuzzing & Network Throttling', async ({ page, context }) => {
        await page.goto('/');

        // Intercept network and throttle to Slow 3G
        const client = await context.newCDPSession(page);
        await client.send('Network.emulateNetworkConditions', {
            offline: false,
            downloadThroughput: ((500 * 1000) / 8) * 0.8,
            uploadThroughput: ((500 * 1000) / 8) * 0.8,
            latency: 400,
        });

        console.log("[Phase 3] Fuzzing Audit Forms on Throttled Network...");
        
        // Find inputs and textareas
        const inputs = await page.locator('input[type="text"], textarea').all();
        const fuzzPayloads = [
            "\0\0\0\0\0",             // Null byte injection
            "A".repeat(10000),          // Buffer overflow / memory bloat
            "🔥💀👽💥🎉".repeat(50),   // Emoji / Multi-byte character failure
            "مرحبا بك في الجحيم"          // Right-to-Left character injection
        ];

        for (const input of inputs) {
            const randomFuzz = fuzzPayloads[Math.floor(Math.random() * fuzzPayloads.length)];
            await input.fill(randomFuzz).catch(() => {});
        }

        // Spam click submit on multiple forms simultaneously while network is throttled
        const submitBtn = page.locator('button[type="submit"], text="Submit", text="SUBMIT AUDIT"').first();
        try {
            await submitBtn.waitFor({ state: 'visible', timeout: 5000 });
            const submits = [];
            for (let i = 0; i < 5; i++) {
                submits.push(submitBtn.click({ force: true, noWaitAfter: true }).catch(() => {}));
            }
            await Promise.all(submits);
        } catch (e) {
            console.log("Submit button not found.");
        }
        
        // Wait to catch race condition effects
        await page.waitForTimeout(3000);
    });
});