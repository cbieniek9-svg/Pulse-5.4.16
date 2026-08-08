#!/usr/bin/env node
'use strict';

/**
 * Headless TGP Command Center API (plain Node — for Windows service / no login session).
 *
 * Usage:
 *   set TGP_DATA_DIR=E:\path\to\install\root
 *   node server.cjs
 *
 * Requires better-sqlite3 rebuilt for this Node (npm run rebuild:node), not Electron ABI.
 */

const path = require('path');
const fs = require('fs');

const appRoot = __dirname;

// Default data dir = install root (parent of resources/), matching Electron dirname(execPath).
if (!process.env.TGP_DATA_DIR || !String(process.env.TGP_DATA_DIR).trim()) {
    process.env.TGP_DATA_DIR = path.resolve(appRoot, '..', '..');
}
process.env.TGP_SERVICE = process.env.TGP_SERVICE || '1';

const { getDataRoot, getLogPath } = require('./src/paths.cjs');
const { startAppServer, defaultLog } = require('./src/lib/app-boot.cjs');
const { acquireProcessLock, releaseProcessLock } = require('./src/lib/process-lock.cjs');

function logMsg(msg) {
    defaultLog(msg);
}

async function main() {
    try {
        fs.mkdirSync(getDataRoot(), { recursive: true });
    } catch (_) { /* ignore */ }

    logMsg(`Headless server starting. data=${getDataRoot()} log=${getLogPath()}`);

    const lock = acquireProcessLock();
    if (!lock.ok) {
        console.error(`[TGP] ${lock.reason}`);
        process.exit(1);
    }

    let runtime;
    try {
        runtime = await startAppServer({
            appRoot,
            log: logMsg,
            onListenError(err) {
                if (err.code === 'EADDRINUSE') {
                    console.error(`[TGP] Port already in use. Stop the other instance or the Windows service.`);
                } else {
                    console.error(`[TGP] Listen failed: ${err.message}`);
                }
            },
        });
    } catch (err) {
        releaseProcessLock();
        console.error('[TGP] Boot failed:', err.message || err);
        process.exit(1);
    }

    console.log(`[TGP_SERVICE] API ready at ${runtime.localAppUrl}`);

    const shutdown = async (signal) => {
        logMsg(`Received ${signal}; shutting down.`);
        try {
            await runtime.close();
        } catch (e) {
            logMsg('Close error: ' + (e.message || e));
        }
        releaseProcessLock();
        process.exit(0);
    };

    process.on('SIGINT', () => { shutdown('SIGINT'); });
    process.on('SIGTERM', () => { shutdown('SIGTERM'); });
    process.on('exit', () => { releaseProcessLock(); });
}

main();
