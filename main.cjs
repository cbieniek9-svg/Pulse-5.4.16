const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

// Desktop Electron's execPath is node_modules/electron/dist — NOT the store install root.
// Without this, getDataRoot() opens a throwaway DB next to electron.exe (no real staff / PINs).
// Must run before any require that opens tgp_ops.db. Matches server.cjs default.
const appRoot = __dirname;
if (!process.env.TGP_DATA_DIR || !String(process.env.TGP_DATA_DIR).trim()) {
    process.env.TGP_DATA_DIR = path.resolve(appRoot, '..', '..');
}

const { getLogPath, getDataRoot } = require('./src/paths.cjs');
const {
    startAppServer,
    probeLocalApiReady,
    canAttachUiOnly,
    defaultLog,
} = require('./src/lib/app-boot.cjs');
const { buildNetworkConfig } = require('./src/lib/network-config.cjs');
const { shouldOpenDesktopUi } = require('./src/lib/desktop-boot-gate.cjs');
const { acquireProcessLock, releaseProcessLock } = require('./src/lib/process-lock.cjs');

const HEADLESS_TEST = process.env.TGP_HEADLESS_TEST === '1' || process.argv.includes('--headless-test');

function logMsg(msg) {
    try { fs.appendFileSync(getLogPath(), `[${new Date().toISOString()}] ${msg}\n`); } catch (_) {}
    if (HEADLESS_TEST) defaultLog(msg);
}

function showBootError(title, message) {
    if (HEADLESS_TEST) {
        console.error(`[BOOT] ${title}: ${message}`);
        return;
    }
    try { dialog.showErrorBox(title, message); } catch (_) { console.error(`[BOOT] ${title}: ${message}`); }
}

// --- SINGLE INSTANCE LOCK ---
if (!app.requestSingleInstanceLock()) {
    app.quit();
} else {
    app.on('second-instance', () => {
        if (HEADLESS_TEST) return;
        if (mainWindow) {
            if (mainWindow.isMinimized()) mainWindow.restore();
            mainWindow.focus();
        }
    });
}

let mainWindow;
let runtimeClose = null;
let ownsProcessLock = false;
let localAppUrl = 'http://127.0.0.1:3001/';
let uiOnlyMode = false;

function createWindow() {
    const isKiosk = process.argv.includes('--kiosk');
    const { APP_VERSION } = require('./src/app-version.cjs');
    mainWindow = new BrowserWindow({
        width: 1400, height: 900,
        show: false,
        kiosk: isKiosk,
        title: `TGP Center Store ${APP_VERSION}`,
        webPreferences: {
            preload: path.join(__dirname, 'preload.cjs'),
            contextIsolation: true,
            nodeIntegration: false,
            // Sandboxed preload cannot require ./src/* — pass version via argv (see preload.cjs).
            additionalArguments: [`--tgp-app-version=${APP_VERSION}`],
        },
    });
    mainWindow.once('ready-to-show', () => { try { mainWindow.show(); } catch (_) {} });
    mainWindow.webContents.on('did-fail-load', (_ev, code, desc, url) => {
        logMsg(`Window load failed: ${code} ${desc} — ${url}`);
    });
    mainWindow.webContents.on('render-process-gone', (_ev, details) => {
        logMsg(`Renderer gone: ${details.reason || 'unknown'} exit=${details.exitCode ?? ''}`);
        // Recover instead of leaving a blank/dead shell after a Chromium crash.
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                setTimeout(() => {
                    try {
                        if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
                    } catch (_) { /* ignore */ }
                }, 500);
            }
        } catch (_) { /* ignore */ }
    });
    // Count/print and similar UIs use window.open('') — allow blank + local app windows.
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
        const raw = String(url || '');
        const ok = !raw
            || raw === 'about:blank'
            || raw.startsWith('http://127.0.0.1')
            || raw.startsWith('http://localhost')
            || (localAppUrl && raw.startsWith(localAppUrl.replace(/\/$/, '')));
        return ok
            ? { action: 'allow', overrideBrowserWindowOptions: { width: 900, height: 700 } }
            : { action: 'deny' };
    });
    mainWindow.loadURL(localAppUrl);
    mainWindow.on('closed', () => { mainWindow = null; });
}

/**
 * Try UI-only attach to a healthy loopback API. Refuses when restart_required is set.
 * @returns {Promise<'attached'|'restart_required'|'not_ready'>}
 */
async function tryAttachUiOnly(port) {
    const probe = await probeLocalApiReady(port, '127.0.0.1', 800);
    const decision = canAttachUiOnly(probe);
    if (decision.attach) {
        uiOnlyMode = true;
        localAppUrl = `http://127.0.0.1:${port}/`;
        logMsg(`Attach-or-serve: API already up at ${localAppUrl} — UI-only mode.`);
        return 'attached';
    }
    if (decision.reason === 'restart_required') {
        showBootError(
            'Restart Required',
            'A Command Center process is already running, but it reports a deploy restart is required.\n\n'
            + 'Close this window and restart the Windows service (or the other Pulse instance) before opening the desktop UI again.',
        );
        app.quit();
        return 'restart_required';
    }
    return 'not_ready';
}

/**
 * Attach-or-serve: if a headless service (or another instance) already answers /api/ready,
 * open the UI only. Otherwise start the API inside Electron (dev / non-service installs).
 * On EADDRINUSE, re-probe and attach if healthy rather than failing immediately.
 */
async function resolveLocalAppUrl() {
    let port = 3001;
    try {
        // Prefer settings/env without opening the DB when attaching to a live service.
        const cfg = buildNetworkConfig({}, process.env);
        port = cfg.port || 3001;
    } catch (_) { /* default 3001 */ }

    const firstAttach = await tryAttachUiOnly(port);
    if (firstAttach === 'attached') {
        return { startedServer: false, openUi: true };
    }
    if (firstAttach === 'restart_required') {
        // app.quit() already called — do not open a window against a stale deploy.
        return { startedServer: false, openUi: false };
    }

    // The service and desktop can be launched at nearly the same time during
    // login. Electron's single-instance lock only coordinates desktop windows;
    // this shared data-root lock prevents both processes from opening SQLite.
    const processLock = acquireProcessLock();
    if (!processLock.ok) {
        // A service holding the lock may still be finishing migrations/listen.
        // Give it a bounded window to become attachable before failing closed.
        for (let attempt = 0; attempt < 60; attempt += 1) {
            await new Promise((resolve) => setTimeout(resolve, 250));
            const retry = await tryAttachUiOnly(port);
            if (retry === 'attached') return { startedServer: false, openUi: true };
            if (retry === 'restart_required') return { startedServer: false, openUi: false };
        }
        const error = new Error(
            `${processLock.reason || 'Another Command Center process owns the data directory'} `
            + 'The existing process did not become ready; restart the Windows service.',
        );
        error.code = 'TGP_PROCESS_LOCKED';
        throw error;
    }
    ownsProcessLock = true;

    try {
        const runtime = await startAppServer({
            appRoot: __dirname,
            log: logMsg,
            onForceRefresh(delta) {
                if (mainWindow && !mainWindow.isDestroyed()) {
                    mainWindow.webContents.send('force-refresh', delta);
                }
            },
            onListenError(err) {
                // EADDRINUSE is handled by the catch below (re-probe / attach).
                if (err?.code === 'EADDRINUSE') return;
                showBootError('Server Error', `Failed to start server: ${err.message}`);
                app.quit();
            },
        });
        runtimeClose = async () => {
            try {
                await runtime.close();
            } finally {
                if (ownsProcessLock) releaseProcessLock();
                ownsProcessLock = false;
            }
        };
        localAppUrl = runtime.localAppUrl;
        return { startedServer: true, openUi: true };
    } catch (err) {
        if (ownsProcessLock) releaseProcessLock();
        ownsProcessLock = false;
        if (err && err.code === 'EADDRINUSE') {
            const retry = await tryAttachUiOnly(port);
            if (retry === 'attached') {
                return { startedServer: false, openUi: true };
            }
            if (retry === 'restart_required') {
                return { startedServer: false, openUi: false };
            }
            showBootError(
                'Port Conflict',
                `Port ${port} is already in use, and no healthy Command Center answered /api/ready.\n\n`
                + 'Stop the other process, or start the Windows service, then open TGP again.',
            );
            app.quit();
            return { startedServer: false, openUi: false };
        }
        throw err;
    }
}

app.whenReady().then(() => {
    logMsg(`Desktop boot data root: ${getDataRoot()}`);
    resolveLocalAppUrl().then((result) => {
        const openUi = shouldOpenDesktopUi({
            startedServer: result.startedServer,
            uiOnlyMode,
            openUi: result.openUi,
        });
        // Never createWindow after restart_required / failed conflict attach (app.quit already called).
        if (!openUi) return;
        if (HEADLESS_TEST) {
            console.log(`[TGP_HEADLESS_TEST] API ready at ${localAppUrl} data=${getDataRoot()}`);
            return;
        }
        createWindow();
    }).catch(err => {
        showBootError('Critical Startup Error', err.message);
        if (HEADLESS_TEST) process.exit(1);
        app.quit();
    });
});

app.on('window-all-closed', () => {
    if (HEADLESS_TEST) return;
    if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
    if (uiOnlyMode) {
        logMsg('UI-only session closing (service keeps running).');
        return;
    }
    const run = async () => {
        try {
            if (typeof runtimeClose === 'function') {
                await runtimeClose();
            } else {
                const { db } = require('./src/db.cjs');
                if (db && typeof db.close === 'function') {
                    db.close();
                    logMsg('System shutting down gracefully. Database closed.');
                }
            }
        } catch (e) {
            logMsg('Shutdown error: ' + e.message);
        }
    };
    // will-quit handlers should be sync-ish; fire close without awaiting Electron lifecycle.
    run();
});
