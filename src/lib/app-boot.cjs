'use strict';

/**
 * Shared Express + DB + scheduler boot for Electron (main.cjs) and headless Node (server.cjs).
 * No BrowserWindow / Electron APIs here.
 */

const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const { randomUUID } = require('crypto');

const { getLogPath } = require('../paths.cjs');
const { createStoreTimeAccessors } = require('./store-time.cjs');
const { createStoreSchedulers } = require('./store-scheduler.cjs');
const { buildNetworkConfig, isAllowedCorsOrigin } = require('./network-config.cjs');
const { ensureLocalHttpsCredentials } = require('./local-https.cjs');
const {
    extractDeviceToken,
    findAuthorizedTrustedDevice,
    hashDeviceToken,
} = require('./trusted-device-tokens.cjs');
const { isManagerRole } = require('./staff-permissions.cjs');
const { APP_VERSION } = require('../app-version.cjs');
const { MAX_ITEM_UPLOAD_BYTES } = require('./item-catalog.cjs');
const { MAX_SHRINK_UPLOAD_BYTES } = require('./floor-shrink.cjs');
const {
    captureDeployBootFingerprint,
    inspectDeployFidelity,
} = require('./deploy-fidelity.cjs');

const LOCAL_HTTP_BIND = '127.0.0.1';

/** Prevent duplicate fatal handlers when startAppServer is invoked more than once. */
let processFatalHandlersRegistered = false;

function defaultLog(msg) {
    try {
        fs.appendFileSync(getLogPath(), `[${new Date().toISOString()}] ${msg}\n`);
    } catch (_) { /* ignore */ }
    if (process.env.TGP_HEADLESS_TEST === '1' || process.env.TGP_SERVICE === '1') {
        console.log(`[TGP] ${msg}`);
    }
}

function isLoopbackRemoteAddress(addr) {
    if (!addr) return false;
    const normalized = String(addr).replace(/^::ffff:/i, '').toLowerCase();
    return normalized === '127.0.0.1'
        || normalized === '::1'
        || normalized === 'localhost';
}

/**
 * Defense-in-depth: reject non-loopback peers on the plaintext HTTP path before
 * credential-bearing handlers run. Shared Express app also serves HTTPS; TLS peers skip this.
 * TLS is detected only via the real socket (`encrypted`) — never `req.secure` / forwarded headers.
 */
function requireHttpsForNonLoopback(req, res, next) {
    if (req.socket?.encrypted) return next();
    const remote = req.socket?.remoteAddress || '';
    if (isLoopbackRemoteAddress(remote)) return next();
    return res.status(426).json({
        error: 'HTTPS is required for store-network access.',
        code: 'HTTPS_REQUIRED',
    });
}

/**
 * Decide whether Electron may attach UI-only to an already-running API.
 * Refuse quiet attach when the live process reports deploy restart_required.
 */
function canAttachUiOnly(probe) {
    if (!probe?.ok) return { attach: false, reason: 'not_ready' };
    if (probe.restart_required) return { attach: false, reason: 'restart_required' };
    return { attach: true, reason: 'ok' };
}

function markHttpsStartupFailed(bootHealth, networkConfig, reason, logMsg) {
    const detail = `HTTPS_STARTUP_FAILED: ${reason}`;
    networkConfig.https_active = false;
    networkConfig.lan_ready = false;
    networkConfig.public_https_base_url = '';
    if (bootHealth && typeof bootHealth === 'object') {
        bootHealth.ok = false;
        bootHealth.status = 'error';
        bootHealth.errors = bootHealth.errors || [];
        if (!bootHealth.errors.some((e) => String(e).includes('HTTPS_STARTUP_FAILED'))) {
            bootHealth.errors.push(detail);
        }
        bootHealth.checks = bootHealth.checks || {};
        bootHealth.checks.https_listener = { ok: false, error: detail };
    }
    try { logMsg(detail); } catch (_) { /* ignore */ }
}

/**
 * Probe whether a TGP API is already listening (for Electron attach-or-serve).
 * @param {number} [port]
 * @param {string} [host]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ ok: boolean, restart_required: boolean }>}
 */
function probeLocalApiReady(port = 3001, host = '127.0.0.1', timeoutMs = 800) {
    return new Promise((resolve) => {
        const done = (ok, restartRequired = false) => resolve({
            ok: !!ok,
            restart_required: !!restartRequired,
        });
        const http = require('http');
        const req = http.get(
            {
                host,
                port,
                path: '/api/ready',
                timeout: timeoutMs,
            },
            (res) => {
                let body = '';
                res.on('data', (c) => { body += c; });
                res.on('end', () => {
                    if (res.statusCode !== 200) return done(false);
                    try {
                        const j = JSON.parse(body);
                        done(j && j.ok === true, !!j.restart_required);
                    } catch (_) {
                        done(false);
                    }
                });
            },
        );
        req.on('error', () => done(false));
        req.on('timeout', () => {
            req.destroy();
            done(false);
        });
    });
}

function resolveStreamCredential({ db, auth, req }) {
    const sessionToken = typeof req?.body?.token === 'string' ? req.body.token : '';
    const session = auth.getSession(sessionToken);
    if (session) {
        return {
            kind: 'staff',
            audience: isManagerRole(session.role) ? 'manager' : 'staff',
            sessionToken,
        };
    }
    const deviceAuth = findAuthorizedTrustedDevice(db, req, {
        requiredPurpose: 'tv',
        allowIpFallback: false,
    });
    if (!deviceAuth.authorized) return null;
    return {
        kind: 'tv',
        audience: 'tv',
        deviceId: deviceAuth.device.id,
        deviceTokenHash: hashDeviceToken(extractDeviceToken(req)),
    };
}

function sweepExpiredStreamTokens(streamTokens, now = Date.now()) {
    for (const [token, entry] of streamTokens) {
        if (!entry || entry.expiresAt <= now) streamTokens.delete(token);
    }
    return streamTokens.size;
}

function issueOneTimeStreamToken(streamTokens, principal, now = Date.now(), options = {}) {
    if (!principal) return '';
    sweepExpiredStreamTokens(streamTokens, now);
    const maxSize = Math.max(1, Number(options.maxSize || 256));
    while (streamTokens.size >= maxSize) {
        streamTokens.delete(streamTokens.keys().next().value);
    }
    const token = randomUUID();
    streamTokens.set(token, {
        principal,
        expiresAt: now + Math.max(1, Number(options.ttlMs || 30000)),
    });
    return token;
}

function consumeOneTimeStreamToken(streamTokens, token, now = Date.now()) {
    if (!token) {
        sweepExpiredStreamTokens(streamTokens, now);
        return null;
    }
    const entry = streamTokens.get(token);
    streamTokens.delete(token);
    sweepExpiredStreamTokens(streamTokens, now);
    return entry && entry.expiresAt > now ? entry.principal : null;
}

function projectStreamEvent(principal, delta = null) {
    void principal;
    void delta;
    return { type: 'REFRESH' };
}

function isStreamPrincipalCurrent({ db, auth, principal }) {
    if (principal?.kind === 'tv') {
        if (!Number.isInteger(Number(principal.deviceId)) || !principal.deviceTokenHash) return false;
        return !!db.get(
            `SELECT id FROM trusted_devices
              WHERE id=? AND device_token_hash=?
                AND status='Authorized' AND device_purpose='tv'`,
            Number(principal.deviceId),
            principal.deviceTokenHash,
        );
    }
    if (principal?.kind === 'staff' && principal.sessionToken) {
        const current = auth.getSession(principal.sessionToken);
        if (!current) return false;
        const audience = isManagerRole(current.role) ? 'manager' : 'staff';
        return audience === principal.audience;
    }
    return false;
}

function createStreamSecurity({
    db,
    auth,
    now = Date.now,
    tokenTtlMs = 30000,
    maxPendingTokens = 256,
    connectionLifetimeMs = 30 * 60 * 1000,
    heartbeatMs = 15000,
} = {}) {
    const pendingTokens = new Map();
    let clients = [];

    const closeClient = (client) => {
        if (!client || client.closed) return;
        client.closed = true;
        try { client.res?.end?.(); } catch (_) { /* already closed */ }
    };

    const maintain = (writeHeartbeat = true) => {
        const currentTime = now();
        sweepExpiredStreamTokens(pendingTokens, currentTime);
        for (const client of clients) {
            if (client.closed
                || client.res?.writableEnded
                || currentTime - client.connectedAt >= connectionLifetimeMs
                || !isStreamPrincipalCurrent({ db, auth, principal: client.principal })) {
                closeClient(client);
            } else if (writeHeartbeat) {
                try { client.res.write(': keep-alive\n\n'); } catch (_) { closeClient(client); }
            }
        }
        clients = clients.filter((client) => !client.closed && !client.res?.writableEnded);
    };

    const timer = heartbeatMs > 0 ? setInterval(maintain, heartbeatMs) : null;
    timer?.unref?.();

    return {
        issue(principal) {
            return issueOneTimeStreamToken(pendingTokens, principal, now(), {
                ttlMs: tokenTtlMs,
                maxSize: maxPendingTokens,
            });
        },
        consume(token) {
            return consumeOneTimeStreamToken(pendingTokens, token, now());
        },
        attach(req, res, principal) {
            const client = {
                id: randomUUID(),
                principal,
                res,
                connectedAt: now(),
                closed: false,
            };
            clients.push(client);
            const remove = () => {
                client.closed = true;
                clients = clients.filter((candidate) => candidate !== client);
            };
            req?.on?.('close', remove);
            req?.on?.('error', remove);
            return client;
        },
        broadcast(delta = null) {
            maintain(false);
            for (const client of clients) {
                try {
                    const event = projectStreamEvent(client.principal, delta);
                    client.res.write(`data: ${JSON.stringify(event)}\n\n`);
                } catch (_) {
                    closeClient(client);
                }
            }
            clients = clients.filter((client) => !client.closed && !client.res?.writableEnded);
        },
        maintain,
        stats() {
            return {
                clientCount: clients.length,
                pendingTokenCount: pendingTokens.size,
            };
        },
        stop() {
            if (timer) clearInterval(timer);
            clients.forEach(closeClient);
            clients = [];
            pendingTokens.clear();
        },
    };
}

function registerStreamRoutes(server, {
    db,
    auth,
    testMode = false,
    now,
    tokenTtlMs,
    maxPendingTokens,
    connectionLifetimeMs,
    heartbeatMs,
} = {}) {
    const security = createStreamSecurity({
        db,
        auth,
        now,
        tokenTtlMs,
        maxPendingTokens,
        connectionLifetimeMs,
        heartbeatMs,
    });
    const issueLimiter = rateLimit({
        windowMs: 60 * 1000,
        max: testMode ? 500 : 30,
        standardHeaders: true,
        legacyHeaders: false,
        message: { error: 'Too many stream token requests.' },
    });
    server.use('/api/stream-token', issueLimiter);
    server.post('/api/stream-token', (req, res) => {
        const principal = resolveStreamCredential({ db, auth, req });
        if (!principal) return res.status(401).end();
        const streamToken = security.issue(principal);
        return res.json({
            streamToken,
            device_auth: principal.kind === 'tv' ? 'token' : null,
        });
    });
    server.get('/api/stream', (req, res) => {
        const principal = security.consume(req.query.st);
        if (!principal || !isStreamPrincipalCurrent({ db, auth, principal })) {
            return res.status(401).end();
        }
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.flushHeaders();
        security.attach(req, res, principal);
        return undefined;
    });
    return security;
}

/**
 * @param {object} opts
 * @param {string} opts.appRoot Absolute path to resources/app
 * @param {(msg: string) => void} [opts.log]
 * @param {(delta: object|null) => void} [opts.onForceRefresh] Electron window refresh hook
 * @param {(err: Error) => void} [opts.onListenError] Called on listen failure before reject
 * @returns {Promise<{
 *   listener: import('http').Server,
 *   networkConfig: object,
 *   localAppUrl: string,
 *   getBootHealth: () => object|null,
 *   close: () => Promise<void>,
 * }>}
 */
async function startAppServer(opts = {}) {
    const appRoot = opts.appRoot || path.resolve(__dirname, '..', '..');
    const logMsg = typeof opts.log === 'function' ? opts.log : defaultLog;
    const onForceRefresh = typeof opts.onForceRefresh === 'function' ? opts.onForceRefresh : null;
    const onListenError = typeof opts.onListenError === 'function' ? opts.onListenError : null;

    const { db, initializeDailyRhythm, initializeSettings } = require('../db.cjs');
    const deployBootFingerprint = captureDeployBootFingerprint(appRoot);
    logMsg(`TGP Center Store ${APP_VERSION}`);

    try {
        db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
        logMsg('Boot checkpoint complete (WAL truncate).');
    } catch (e) {
        logMsg('Boot checkpoint failed: ' + e.message);
    }

    const networkConfig = buildNetworkConfig(db.getSettings ? db.getSettings() : {}, process.env);
    const localAppUrl = `http://127.0.0.1:${networkConfig.port}/`;
    if (networkConfig.warnings?.length) {
        logMsg(`Network boundary: ${networkConfig.warnings.join(' | ')}`);
    }

    const authFactory = require('../auth.cjs');
    const apiFactory = require('../api.cjs');
    const auth = authFactory(db);
    const storeTime = createStoreTimeAccessors(() => db.getSettings());
    let getStoreDateStamp = storeTime.getStoreDateStamp;
    let getStoreDayName = storeTime.getStoreDayName;
    let getStoreClockPayload = storeTime.getStoreClockPayload;

    let streamSecurity = null;
    let bootHealth = null;
    let globalSweep = null;
    let globalRhythm = null;
    let globalWeeklyBackup = null;
    let storeSchedulers = null;
    let httpServer = null;

    const broadcastUpdate = (delta = null) => {
        streamSecurity?.broadcast(delta);
        if (onForceRefresh) {
            try { onForceRefresh(delta); } catch (_) { /* ignore */ }
        }
    };

    if (!processFatalHandlersRegistered) {
        processFatalHandlersRegistered = true;
        process.on('uncaughtException', (err) => {
            logMsg(`[FATAL] Uncaught Exception: ${err.message}\n${err.stack}`);
        });
        process.on('unhandledRejection', (reason, promise) => {
            logMsg(`[FATAL] Unhandled Rejection at: ${promise} reason: ${reason}`);
        });
    }

    const server = express();
    // Never honor X-Forwarded-* for HTTPS/client IP decisions on the store LAN path.
    server.set('trust proxy', false);
    server.use(cors({
        origin: (origin, cb) => cb(null, isAllowedCorsOrigin(origin, networkConfig)),
    }));
    // Reject LAN plaintext before body parsers / credential routes can run.
    server.use(requireHttpsForNonLoopback);
    // The catalog upload ships the file as base64, which inflates it by a third, so this
    // one route needs headroom the rest of the API should not get. Registering it first
    // wins: body-parser skips a request whose body another parser already read.
    const catalogBodyLimit = Math.ceil((MAX_ITEM_UPLOAD_BYTES * 4) / 3) + 1024 * 1024;
    const shrinkBodyLimit = Math.ceil((MAX_SHRINK_UPLOAD_BYTES * 4) / 3) + 1024 * 1024;
    server.use('/api/items/import-csv', express.json({ limit: catalogBodyLimit }));
    server.use('/api/markdown/shrink/import-csv', express.json({ limit: shrinkBodyLimit }));
    server.use(express.json({ limit: '10mb' }));
    // Without this, an oversized body fails as an HTML error page the portals cannot read.
    server.use((err, req, res, next) => {
        if (err?.type !== 'entity.too.large') return next(err);
        const shrinkRoute = String(req.originalUrl || req.url || '').includes('/markdown/shrink/import');
        const capMb = Math.round((shrinkRoute ? MAX_SHRINK_UPLOAD_BYTES : MAX_ITEM_UPLOAD_BYTES) / (1024 * 1024));
        return res.status(413).json({
            success: false,
            error: shrinkRoute
                ? `That upload is too large. Shrink files are capped at ${capMb} MB.`
                : `That upload is too large. Catalog files are capped at ${capMb} MB.`,
        });
    });
    // Allow camera on /count (and other portals) when served over HTTPS.
    server.use((req, res, next) => {
        res.setHeader('Permissions-Policy', 'camera=(self), microphone=()');
        next();
    });

    // Unauthenticated readiness probe (Electron attach-or-serve + service checks).
    // `ok` means the process is listening. Deploy skew is surfaced via restart_required.
    server.get('/api/ready', (_req, res) => {
        const deploy = inspectDeployFidelity(deployBootFingerprint);
        res.json({
            ok: true,
            appVersion: APP_VERSION,
            service: process.env.TGP_SERVICE === '1',
            uptime: process.uptime(),
            restart_required: !!deploy.restart_required,
            deploy,
            https: {
                enabled: !!networkConfig.https_enabled,
                active: !!networkConfig.https_active,
                port: networkConfig.https_port || null,
                public_base_url: networkConfig.https_active
                    ? (networkConfig.public_https_base_url || '')
                    : '',
            },
            lan_ready: !!networkConfig.lan_ready,
            lan_addresses: networkConfig.lan_addresses || [],
        });
    });

    const testMode = process.env.TGP_TEST_MODE === '1' || process.env.TGP_TRAINING_TEST === '1';
    const apiLimiter = rateLimit({
        windowMs: 1 * 60 * 1000,
        max: testMode ? 10000 : 200,
        standardHeaders: true,
        legacyHeaders: false,
    });
    server.use('/api/', apiLimiter);

    server.get('/mobile.html', (req, res) => res.redirect(301, '/'));

    const uiDist = path.join(appRoot, 'dist/ui');
    const uiIndex = path.join(uiDist, 'index.html');
    server.use('/app-assets', express.static(path.join(uiDist, 'app-assets')));

    const reactPortalPaths = [
        '/',
        '/index.html',
        '/reports',
        '/settings',
        '/rec',
        '/financial',
        '/log',
        '/markdown',
        '/cs',
        '/count',
        '/safe',
        '/saafe',
    ];
    server.get(reactPortalPaths, (req, res) => {
        if (fs.existsSync(uiIndex)) return res.sendFile(uiIndex);
        return res.status(503).type('text/plain').send(
            'React UI is not built. Run npm run build:ui in resources/app, then restart the app.',
        );
    });

    // Old bookmarks and printed sheets sometimes still point at the *.html files.
    // Those templates are no longer the live portals — permanently send them to the
    // React SPA paths so /rec.html, /markdown.html, etc. never diverge from /rec.
    // /betacs was retired in favor of /cs (client Navigate + server 301).
    const legacyHtmlRedirects = {
        '/rec.html': '/rec',
        '/markdown.html': '/markdown',
        '/cs.html': '/cs',
        '/betacs': '/cs',
        '/betacs/': '/cs',
        '/count.html': '/count',
        '/safe.html': '/safe',
        '/reports.html': '/reports',
        '/mgr-settings.html': '/settings',
    };
    for (const [from, to] of Object.entries(legacyHtmlRedirects)) {
        server.get(from, (req, res) => res.redirect(301, to));
    }

    server.use('/public', express.static(path.join(appRoot, 'public')));
    server.get('/favicon.ico', (_req, res) => {
        res.sendFile(path.join(appRoot, 'public', 'favicon.ico'), (err) => {
            if (err) res.status(204).end();
        });
    });
    server.use('/assets', express.static(path.join(appRoot, 'dist/assets')));
    server.use(express.static(path.join(appRoot, 'dist'), { index: false }));

    const authLimiter = rateLimit({
        windowMs: 15 * 60 * 1000,
        max: testMode ? 500 : (process.env.TGP_TRAINING_TEST ? 50 : 5),
        message: { error: 'Too many login attempts. Blocked for 15 mins.' },
        standardHeaders: true,
        legacyHeaders: false,
    });
    server.use('/api/mobile-auth', authLimiter);

    streamSecurity = registerStreamRoutes(server, { db, auth, testMode });

    const api = apiFactory(server, db, auth, broadcastUpdate, getStoreDateStamp, getStoreDayName, getStoreClockPayload, () => bootHealth, () => networkConfig);
    globalSweep = api.executeEODSweep;
    globalRhythm = api.executeDailyRhythm;
    globalWeeklyBackup = api.executeWeeklyBackup;

    const serveTv = (req, res) => {
        const nativeShell = db.get("SELECT setting_value FROM settings WHERE setting_name = 'TV_Native_Shell'")?.setting_value === '1';
        const tvFile = nativeShell
            ? path.join(appRoot, 'public/tv/tv-dashboard.html')
            : path.join(appRoot, 'dist/index.html');
        return res.sendFile(tvFile);
    };
    server.get('/tv', serveTv);
    server.get('/tv/', serveTv);
    server.get('/TV', (req, res) => res.redirect(301, '/tv' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')));
    server.get('/TV/', (req, res) => res.redirect(301, '/tv' + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '')));

    auth.migrateStaffPins();
    // Tracked and unref'd so shutdown is clean and this timer never holds the process open.
    const sessionCleanupTimer = setInterval(() => auth.cleanupSessions(), 5 * 60 * 1000);
    sessionCleanupTimer.unref?.();
    initializeDailyRhythm();
    initializeSettings();

    try {
        const { checkDatabaseHealth, recordBootHealth } = require('./db-health.cjs');
        const { runManagerHubBootCheck, persistManagerHubBootStatus } = require('./manager-hub-boot.cjs');
        const { loadHeatMap } = require('../dal/heatmap.cjs');
        bootHealth = checkDatabaseHealth(db, { maxBackupAgeHours: 72 });
        const managerHubBoot = runManagerHubBootCheck(db, {
            getStoreDateStamp,
            getStoreClockPayload,
            getSettings: () => db.getSettings(),
            cachedHeatMap: loadHeatMap(db),
        });
        persistManagerHubBootStatus(db, managerHubBoot);
        bootHealth.checks = bootHealth.checks || {};
        bootHealth.checks.manager_hub = managerHubBoot;
        if (!managerHubBoot.ok) {
            bootHealth.warnings = bootHealth.warnings || [];
            bootHealth.warnings.push(`Manager hub boot probe failed: ${managerHubBoot.error}`);
            if (bootHealth.status === 'ok') bootHealth.status = 'warning';
        } else if (managerHubBoot.repairs?.length) {
            bootHealth.warnings = bootHealth.warnings || [];
            bootHealth.warnings.push(`Manager hub auto-repair on boot: ${managerHubBoot.repairs.join(', ')}`);
            if (bootHealth.status === 'ok') bootHealth.status = 'warning';
        }
        const { flushAllCloseAuditOutbox } = require('./edmonton-receiving-integrity.cjs');
        const closeAuditDrain = flushAllCloseAuditOutbox(db);
        bootHealth.checks.close_audit_outbox = {
            ok: closeAuditDrain.pending === 0,
            status: closeAuditDrain.pending === 0 ? 'ok' : 'warning',
            ...closeAuditDrain,
        };
        if (closeAuditDrain.pending > 0) {
            bootHealth.warnings = bootHealth.warnings || [];
            bootHealth.warnings.push(
                `${closeAuditDrain.pending} financial close audit event(s) remain pending.`,
            );
            if (bootHealth.status === 'ok') bootHealth.status = 'warning';
        }
        recordBootHealth(db, bootHealth);
        const details = [
            ...(bootHealth.errors || []).map((m) => `ERROR ${m}`),
            ...(bootHealth.warnings || []).map((m) => `WARN ${m}`),
        ];
        logMsg(`Boot health: ${bootHealth.status}${details.length ? ` — ${details.join(' | ')}` : ''}`);
        if (!managerHubBoot.ok) {
            logMsg(`Manager hub boot probe failed: ${managerHubBoot.error}`);
        } else if (managerHubBoot.repairs?.length) {
            logMsg(`Manager hub boot repairs: ${managerHubBoot.repairs.join(', ')}`);
        }
    } catch (e) {
        logMsg('Boot health check failed: ' + e.message);
        bootHealth = { ok: false, status: 'error', checked_at: new Date().toISOString(), errors: [e.message], warnings: [], checks: {} };
    }

    storeSchedulers = createStoreSchedulers({
        getTimezone: storeTime.getTimezone,
        log: logMsg,
        db,
        broadcastUpdate,
        getStoreDateStamp,
        onEod: () => globalSweep(new Date(), { vacuum: true, skipOrderHistoryArchive: false }),
        onRhythm: (opts) => {
            try {
                const reason = opts?.reason || 'scheduled';
                if (typeof globalRhythm !== 'function') return null;
                const { maybeEnsureMorningRhythm } = require('./daily-rhythm.cjs');
                const clock = typeof getStoreClockPayload === 'function' ? getStoreClockPayload() : {};
                return maybeEnsureMorningRhythm(
                    db,
                    {
                        getStoreDateStamp,
                        getStoreDayName,
                        getTimezone: storeTime.getTimezone,
                        getStoreClockPayload,
                        storeTime: clock.storeTime,
                        broadcastUpdate,
                    },
                    globalRhythm,
                    { reason },
                );
            } catch (err) {
                logMsg(`[RHYTHM] Scheduled/watchdog ensure failed: ${err && err.message}`);
                return null;
            }
        },
        onWeeklyBackup: () => globalWeeklyBackup?.(),
    });
    storeSchedulers.start();

    // Listen first so /api/ready stays reachable during EOD catch-up (can take minutes).
    const httpBindHost = networkConfig.http_bind_host || LOCAL_HTTP_BIND;
    httpServer = await new Promise((resolve, reject) => {
        let startupSettled = false;
        const listener = http.createServer(server);
        listener.on('error', (err) => {
            if (startupSettled) {
                logMsg(`HTTP server error (post-listen): ${err.message}`);
                return;
            }
            if (err.code === 'EADDRINUSE') {
                logMsg(`BOOT ERROR: Port ${networkConfig.port} already in use. Server not started.`);
            } else {
                logMsg('BOOT ERROR (listen): ' + err.message);
            }
            // Nobody gets a close() handle when the boot rejects, so release what has
            // already been started here — otherwise the cron timers keep the process
            // alive forever instead of it failing fast.
            try { clearInterval(sessionCleanupTimer); } catch (_) { /* ignore */ }
            try { storeSchedulers?.stop?.(); } catch (_) { /* ignore */ }
            if (onListenError) {
                try { onListenError(err); } catch (_) { /* ignore */ }
            }
            reject(err);
        });
        listener.listen(networkConfig.port, httpBindHost, () => {
            startupSettled = true;
            logMsg(`Server listening on ${httpBindHost}:${networkConfig.port}`);
            resolve(listener);
        });
    });

    let httpsServer = null;
    const httpsBindHost = networkConfig.https_bind_host || networkConfig.bind_host || httpBindHost;
    if (networkConfig.https_enabled) {
        try {
            const creds = ensureLocalHttpsCredentials();
            httpsServer = await new Promise((resolve) => {
                let startupSettled = false;
                const listener = https.createServer(
                    { key: creds.key, cert: creds.cert },
                    server,
                );
                listener.on('error', (err) => {
                    if (startupSettled) {
                        logMsg(`HTTPS server error (post-listen): ${err.message}`);
                        return;
                    }
                    logMsg(`HTTPS BOOT ERROR: ${err.message} — store-network HTTPS is unavailable`);
                    try { listener.close(); } catch (_) { /* ignore */ }
                    resolve(null);
                });
                listener.listen(networkConfig.https_port, httpsBindHost, () => {
                    startupSettled = true;
                    logMsg(
                        `HTTPS listening on ${httpsBindHost}:${networkConfig.https_port}`
                        + ` (camera) lan=${(creds.lanIps || []).join(',') || 'none'}`
                        + (creds.generated ? ' [cert generated]' : ' [cert reused]'),
                    );
                    resolve(listener);
                });
            });
            if (httpsServer) {
                networkConfig.https_active = true;
                networkConfig.lan_ready = !!(
                    networkConfig.https_active
                    && networkConfig.allow_lan_clients
                    && (networkConfig.lan_addresses || []).length > 0
                );
                if (!networkConfig.lan_ready) {
                    networkConfig.public_https_base_url = `https://127.0.0.1:${networkConfig.https_port}`;
                }
                if (bootHealth) {
                    bootHealth.checks = bootHealth.checks || {};
                    bootHealth.checks.https_listener = {
                        ok: true,
                        bind_host: httpsBindHost,
                        port: networkConfig.https_port,
                    };
                }
            } else if (networkConfig.allow_lan_clients) {
                markHttpsStartupFailed(
                    bootHealth,
                    networkConfig,
                    `Could not bind HTTPS on ${httpsBindHost}:${networkConfig.https_port}`,
                    logMsg,
                );
                try {
                    const { recordBootHealth } = require('./db-health.cjs');
                    recordBootHealth(db, bootHealth);
                } catch (_) { /* ignore */ }
            } else {
                networkConfig.https_active = false;
                networkConfig.lan_ready = false;
                networkConfig.public_https_base_url = '';
            }
        } catch (e) {
            httpsServer = null;
            if (networkConfig.allow_lan_clients) {
                markHttpsStartupFailed(
                    bootHealth,
                    networkConfig,
                    e.message || 'HTTPS credential setup failed',
                    logMsg,
                );
                try {
                    const { recordBootHealth } = require('./db-health.cjs');
                    recordBootHealth(db, bootHealth);
                } catch (_) { /* ignore */ }
            } else {
                networkConfig.https_active = false;
                networkConfig.lan_ready = false;
                networkConfig.public_https_base_url = '';
                logMsg(`HTTPS setup failed: ${e.message}`);
            }
        }
    } else {
        networkConfig.https_active = false;
        networkConfig.lan_ready = false;
        networkConfig.public_https_base_url = '';
    }

    // Catch-up after listen so attach/service probes are not blocked. Progress lives on bootHealth.
    if (bootHealth) {
        bootHealth.checks = bootHealth.checks || {};
        bootHealth.checks.eod_catch_up = { ok: true, status: 'running', started_at: new Date().toISOString() };
    }
    const eodCatchUpPromise = catchUpMissedSweeps({
        db,
        getStoreDateStamp,
        logMsg,
        getSweep: () => globalSweep,
        getRhythm: () => globalRhythm,
    }).then(() => {
        if (!bootHealth) return;
        bootHealth.checks = bootHealth.checks || {};
        bootHealth.checks.eod_catch_up = {
            ok: true,
            status: 'ok',
            completed_at: new Date().toISOString(),
        };
    }).catch((err) => {
        logMsg('EOD catch-up async error: ' + (err && err.message));
        if (!bootHealth) return;
        bootHealth.checks = bootHealth.checks || {};
        bootHealth.checks.eod_catch_up = {
            ok: false,
            status: 'error',
            error: err && err.message,
            completed_at: new Date().toISOString(),
        };
        bootHealth.warnings = bootHealth.warnings || [];
        bootHealth.warnings.push(`EOD catch-up failed: ${err && err.message}`);
        if (bootHealth.status === 'ok') bootHealth.status = 'warning';
    });

    return {
        listener: httpServer,
        httpsListener: httpsServer,
        networkConfig,
        localAppUrl,
        trustProxy: server.get('trust proxy'),
        getBootHealth: () => bootHealth,
        close: async () => {
            try { clearInterval(sessionCleanupTimer); } catch (_) { /* ignore */ }
            try { streamSecurity?.stop(); } catch (_) { /* ignore */ }
            try { storeSchedulers?.stop?.(); } catch (_) { /* ignore */ }
            await Promise.all([
                new Promise((resolve) => {
                    if (!httpServer) return resolve();
                    httpServer.close(() => resolve());
                }),
                new Promise((resolve) => {
                    if (!httpsServer) return resolve();
                    httpsServer.close(() => resolve());
                }),
            ]);
            try {
                await eodCatchUpPromise;
            } catch (_) { /* status already recorded above */ }
            try {
                if (db && typeof db.close === 'function') db.close();
                logMsg('System shutting down gracefully. Database closed.');
            } catch (e) {
                logMsg('Shutdown error: ' + e.message);
            }
        },
    };
}

async function catchUpMissedSweeps({ db, getStoreDateStamp, logMsg, getSweep, getRhythm }) {
    try {
        const lastSweepRow = db.get("SELECT setting_value FROM settings WHERE setting_name = 'Last_EOD_Sweep'");
        const todayStr = getStoreDateStamp();
        const globalSweep = getSweep();
        if (lastSweepRow?.setting_value && lastSweepRow.setting_value < todayStr) {
            let lastDate = new Date(lastSweepRow.setting_value + 'T12:00:00');
            const today = new Date(todayStr + 'T12:00:00');
            let iterations = 0;
            const MAX_CATCHUP_DAYS = 90;
            while (lastDate < today && iterations < MAX_CATCHUP_DAYS) {
                iterations++;
                lastDate.setDate(lastDate.getDate() + 1);
                const dayToSweep = getStoreDateStamp(lastDate);
                logMsg(`Catching up on missed EOD for ${dayToSweep}... (${iterations}/${MAX_CATCHUP_DAYS})`);
                const skipArch = dayToSweep !== todayStr;
                if (globalSweep) {
                    const result = await globalSweep(lastDate, { vacuum: false, skipOrderHistoryArchive: skipArch });
                    // Busy means another sweep owns the DB — stop advancing so we do not
                    // pretend intermediate days completed and leave Last_EOD_Sweep behind.
                    if (result?.skipped && result.reason === 'busy') {
                        logMsg(`EOD catch-up paused — sweep busy on ${dayToSweep}`);
                        break;
                    }
                }
                if (dayToSweep === todayStr) break;
            }
            if (iterations >= MAX_CATCHUP_DAYS) logMsg('Catchup capped at 90 days — Last_EOD_Sweep may be corrupted.');
        } else if (!lastSweepRow?.setting_value) {
            if (globalSweep) await globalSweep(new Date(), { vacuum: false, skipOrderHistoryArchive: true });
        } else if (lastSweepRow?.setting_value === todayStr && globalSweep) {
            // Same store day already purged — still complete a missing post package when needed.
            // executeEODSweep no-ops when backup is complete; otherwise runs post-only recovery.
            logMsg(`EOD same-day backup check for ${todayStr}...`);
            await globalSweep(new Date(), { vacuum: false, skipOrderHistoryArchive: true });
        }
    } catch (e) {
        logMsg('EOD catch-up error: ' + e.message);
    }

    // Rhythm must not die when EOD catch-up throws (missed morning board).
    try {
        const globalRhythm = getRhythm();
        if (globalRhythm) {
            if (typeof globalRhythm.ensureOnBoot === 'function') globalRhythm.ensureOnBoot();
            else globalRhythm();
        }
    } catch (e) {
        logMsg('Rhythm boot ensure failed: ' + e.message);
    }
}

module.exports = {
    startAppServer,
    probeLocalApiReady,
    canAttachUiOnly,
    defaultLog,
    requireHttpsForNonLoopback,
    isLoopbackRemoteAddress,
    resolveStreamCredential,
    issueOneTimeStreamToken,
    consumeOneTimeStreamToken,
    sweepExpiredStreamTokens,
    projectStreamEvent,
    isStreamPrincipalCurrent,
    createStreamSecurity,
    registerStreamRoutes,
    catchUpMissedSweeps,
};
