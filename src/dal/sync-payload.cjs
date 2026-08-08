'use strict';

const fs = require('fs');
const { getDbPath } = require('../paths.cjs');
const { recordAppError, logWarn } = require('../lib/app-log.cjs');
const { SENSITIVE_SETTING_KEYS } = require('../constants/api-settings.cjs');
const { getStoreMeta } = require('../constants/store-meta.cjs');
const { addDaysToDateStamp } = require('../lib/store-time.cjs');
const { computeShiftMetrics, parseHardwareArrived } = require('../lib/shift-metrics.cjs');
const { getTvCustomerOrders, getMobileCustomerOrders, isBetacsEnabled, isCsFullEnabled, isCsHubEnabled } = require('../lib/special-orders.cjs');
const { isCsCrmEnabled } = require('../lib/cs-customers.cjs');
const { isInventoryCountEnabled } = require('../lib/inventory-count.cjs');
const { isStoreTransfersEnabled } = require('../lib/store-transfers.cjs');
const {
    isTrainingStaff,
    isUnassignedOptionEnabled,
} = require('../lib/training-staff.cjs');
const { loadPresenceConfig } = require('../lib/presence-config.cjs');
const { buildManagerHubMeta, buildPresenceTvSummary } = require('../lib/manager-hub-meta.cjs');
const {
    attachPalletsToDockRows, listReceivingDayLog, PALLET_DEPARTMENTS,
} = require('../lib/receiving-pallets.cjs');
const { buildDailyDirectionFloorView, loadDailyDirectionFloor } = require('../lib/daily-direction.cjs');
const {
    buildCommsSyncPayload,
    mapTickerForLegacyClients,
    isMessageCenterEnabled,
} = require('../lib/comms-center.cjs');
const { isManagerRole, listStaffForSync } = require('../lib/staff-permissions.cjs');
const { loadStaffNameAliases } = require('../lib/staff-name-aliases.cjs');
const { classifyShift } = require('../lib/schedule-role-buckets.cjs');
const {
    findAuthorizedTrustedDevice,
    listTrustedDevicesSafe,
} = require('../lib/trusted-device-tokens.cjs');
const { buildSafetySyncPayload } = require('../lib/safety-blurbs.cjs');
const { listCanonicalVendors } = require('../lib/vendor-canonical.cjs');
const { buildTvDisplayPrefs } = require('../lib/tv-display-prefs.cjs');
const { filterPendingExpectedForStoreDate } = require('../lib/expected-orders-day.cjs');
const { listShiftLeadOptions, getActiveManagerStatus } = require('../lib/shift-lead.cjs');
const { buildMorningRhythmStatus } = require('../lib/daily-rhythm.cjs');


function resolveSyncAudience(session) {
    if (!session) return 'public';
    if (session.role === 'TV') return 'tv';
    if (isManagerRole(session.role)) return 'manager';
    return 'staff';
}

function redactSettingsForAudience(settings, audience) {
    if (audience === 'manager') return settings;
    if (audience === 'public') {
        return Object.hasOwn(settings, 'Unassigned_Option_Enabled')
            ? { Unassigned_Option_Enabled: settings.Unassigned_Option_Enabled }
            : {};
    }
    return Object.fromEntries(Object.entries(settings).filter(([k]) => !SENSITIVE_SETTING_KEYS.has(k)));
}

function publicStaffRow(s) {
    return { name: s.name };
}

function tvOrderRow(order) {
    return {
        order_id: order?.order_id,
        location: order?.location,
        item: order?.item,
        status: order?.status,
        source: order?.source,
    };
}

function buildOrderPayloadForAudience(db, audience) {
    const ordersTv = getTvCustomerOrders(db).map(tvOrderRow);
    if (audience === 'tv') return { orders_tv: ordersTv };
    return {
        orders: getMobileCustomerOrders(db),
        orders_tv: ordersTv,
    };
}

function authorizeTvSyncRequest(db, req) {
    return findAuthorizedTrustedDevice(db, req, {
        requiredPurpose: 'tv',
        allowIpFallback: false,
    });
}

const TV_SETTING_KEYS = [
    'FIFO_Aisle_Assignments',
    'Hardware_Arrived',
    'Order_Start',
    'Safety_Message',
    'Store_Display_Name',
    'TV_Col_Split',
    'TV_KPI_Size',
    'TV_Map_Size',
    'TV_Safety_Message',
    'TV_Scale',
    'Zone_Mapping',
    'Zone_Names',
    'Zone_Ownership',
    'Zone_Section_Labels',
];

function projectTvSettings(settings) {
    return Object.fromEntries(TV_SETTING_KEYS.map((key) => [key, settings?.[key] ?? '']));
}

function projectTvTask(task) {
    return {
        task_id: task?.task_id ?? null,
        task_detail: task?.task_detail ?? '',
        status: task?.status ?? '',
        priority: task?.priority ?? '',
        zone: task?.zone ?? '',
        assigned_to: task?.assigned_to ?? '',
    };
}

function projectTvKpis(kpis) {
    return {
        g: Number(kpis?.g || 0),
        f: Number(kpis?.f || 0),
        h: Number(kpis?.h || 0),
        staff: Number(kpis?.staff || 0),
        shift_active: Boolean(kpis?.shift_active),
        shift_done: Boolean(kpis?.shift_done),
        shift_pph: kpis?.shift_pph ?? null,
        shift_pph_final: kpis?.shift_pph_final ?? null,
        shift_standard_pph: kpis?.shift_standard_pph ?? null,
        order_staff: kpis?.order_staff ?? null,
        shift_total_pieces: kpis?.shift_total_pieces ?? null,
    };
}

function projectTvKillDate(row, includeDays = false) {
    const projected = {
        id: row?.id ?? null,
        item: row?.item ?? '',
        zone: row?.zone ?? '',
        kill_date: row?.kill_date ?? '',
    };
    if (includeDays) projected.days_until = row?.days_until ?? null;
    return projected;
}

function projectTvCommsMessage(message) {
    return {
        msg_id: message?.msg_id ?? null,
        lane: message?.lane ?? '',
        body: message?.body ?? '',
        priority: message?.priority ?? 'info',
        zone: message?.zone ?? '',
        posted_by: message?.posted_by ?? '',
        source: message?.source ?? '',
        dedupe_key: message?.dedupe_key ?? '',
        meta: {
            kind: message?.meta?.kind ?? '',
            type: message?.meta?.type ?? '',
        },
    };
}

function projectTvComms(comms) {
    return {
        enabled: Boolean(comms?.enabled),
        pinned: (comms?.pinned || []).map(projectTvCommsMessage),
        ticker: (comms?.ticker || []).map(projectTvCommsMessage),
    };
}

function projectTvDailyDirection(floor) {
    if (!floor) return null;
    const direction = floor.daily_direction || floor;
    return {
        daily_direction: {
            status: direction?.status ?? '',
            status_color: direction?.status_color ?? '',
            floor_message: direction?.floor_message ?? '',
            posted_at: direction?.posted_at ?? null,
            posted_by: direction?.posted_by ?? '',
            updated_at: direction?.updated_at ?? null,
            updated_by: direction?.updated_by ?? '',
            update_count: Number(direction?.update_count || 0),
            must_wins: (direction?.must_wins || []).slice(0, 3).map((win) => ({
                text: typeof win === 'string' ? win : String(win?.text || ''),
            })),
        },
    };
}

function projectTvPresence(presence) {
    if (!presence) return null;
    return {
        order_hint: presence.order_hint ? {
            count_label: presence.order_hint.count_label ?? '',
            beacon_count: Number(presence.order_hint.beacon_count || 0),
        } : null,
        zone_occupancy: (presence.zone_occupancy || []).slice(0, 4).map((zone) => ({
            zone_key: zone?.zone_key ?? '',
            count: Number(zone?.count || 0),
        })),
        offline_count: Number(presence.offline_count || 0),
    };
}

function buildTvSyncPayload({
    db,
    APP_VERSION,
    settings,
    tvDisplay,
    clock,
    today,
    kpis,
    killWarnings,
    commsPayload,
    safety,
    dailyDirectionFloor,
    presenceTv,
}) {
    const store = getStoreMeta(settings);
    const tickerRows = isMessageCenterEnabled(settings)
        ? mapTickerForLegacyClients(commsPayload)
        : db.all('SELECT msg_id, message FROM ticker');
    return {
        appVersion: APP_VERSION,
        deviceSessionActive: true,
        syncAudience: 'tv',
        tv_display: tvDisplay,
        storeDate: today,
        storeWeekday: clock.storeWeekday,
        storeDateLabel: clock.storeDateLabel,
        storeTime: clock.storeTime,
        storeTimezone: clock.storeTimezone || store.timezone,
        store: {
            displayName: store.displayName ?? '',
            timezone: store.timezone ?? '',
        },
        settings: projectTvSettings(settings),
        tasks: db.all(`
            SELECT * FROM tasks WHERE status='Open'
            ORDER BY
                CASE WHEN task_id LIKE 'AUTO-PULL-%' THEN 0 ELSE 1 END,
                CASE priority WHEN 'Urgent' THEN 1 WHEN 'High' THEN 2 ELSE 3 END,
                time_submitted
        `).map(projectTvTask),
        ...buildOrderPayloadForAudience(db, 'tv'),
        kpis: projectTvKpis(kpis),
        ticker: tickerRows.map((row) => ({ message: row?.message ?? row?.note ?? '' })),
        comms: projectTvComms(commsPayload),
        daily_direction_floor: projectTvDailyDirection(dailyDirectionFloor),
        daily_safety_focus: safety?.focus?.message
            ? { message: String(safety.focus.message) }
            : null,
        presence_tv: projectTvPresence(presenceTv),
        kill_dates: db.all(
            "SELECT id, item, zone, kill_date FROM kill_dates WHERE status='Active' ORDER BY kill_date ASC",
        ).map((row) => projectTvKillDate(row)),
        kill_warnings: killWarnings.map((row) => projectTvKillDate(row, true)),
    };
}

/**
 * Build the JSON body for `GET /api/sync`.
 * @param {object} p
 * @param {object} p.db
 * @param {object} p.auth
 * @param {object} p.req
 * @param {string} p.APP_VERSION
 * @param {function} p.getStoreDateStamp
 * @param {function} [p.getStoreClockPayload]
 * @param {object} p.cachedHeatMap
 */
function readSettingJson(db, key, fallback) {
    try {
        const row = db.get('SELECT setting_value FROM settings WHERE setting_name=?', key);
        if (!row?.setting_value) return fallback;
        return JSON.parse(row.setting_value);
    } catch (_) {
        return fallback;
    }
}

function assembleSyncPayload({ db, auth, req, APP_VERSION, getStoreDateStamp, getStoreClockPayload, cachedHeatMap }) {
    const settings = db.getSettings();

    const sentToken = Boolean(req.header('x-session-token'));
    let session = auth.getSession(req.header('x-session-token'));
    let trustedDevice = null;
    let deviceAuth = { authorized: false, via: null, device: null };
    if (!session) {
        deviceAuth = authorizeTvSyncRequest(db, req);
        if (deviceAuth.authorized) {
            trustedDevice = deviceAuth.device;
            session = { name: `TV:${trustedDevice.label || trustedDevice.ip_address || 'Device'}`, role: 'TV' };
        }
    }
    const isAuth = !!session;
    const audience = resolveSyncAudience(session);
    const isTv = audience === 'tv';
    const isManager = audience === 'manager';
    const isStaffAuth = isAuth && !isTv;

    const publicSettings = redactSettingsForAudience(settings, audience);
    const tvDisplay = buildTvDisplayPrefs(settings);
    const clock = typeof getStoreClockPayload === 'function' ? getStoreClockPayload() : {};
    const today = getStoreDateStamp();

    if (audience === 'public') {
        const loginStaff = listStaffForSync(db)
            .filter((s) => (
                s.active === 1
                && s.app_access === 1
                && !isManagerRole(s.role)
                && !isTrainingStaff(s.name)
            ))
            .map(publicStaffRow);
        const presenceConfig = loadPresenceConfig(db);
        // Stable empty shells let unauthenticated clients render login without
        // querying or exposing operational/live records.
        return {
            appVersion: APP_VERSION,
            sessionActive: false,
            syncAudience: 'public',
            tv_display: tvDisplay,
            features: {
                trainingMode: false,
                unassignedLogin: isUnassignedOptionEnabled(settings),
                betacs: isCsFullEnabled(settings),
                csFull: isCsFullEnabled(settings),
                csHub: isCsHubEnabled(settings),
                csCrm: isCsCrmEnabled(settings) && isCsFullEnabled(settings),
                inventoryCount: isInventoryCountEnabled(settings),
                storeTransfers: isStoreTransfersEnabled(settings),
                messageCenter: isMessageCenterEnabled(settings),
                presence: presenceConfig.enabled,
            },
            storeDate: today,
            storeWeekday: clock.storeWeekday,
            storeDateLabel: clock.storeDateLabel,
            storeTime: clock.storeTime,
            storeTimeSeconds: clock.storeTimeSeconds,
            storeTimezone: clock.storeTimezone || getStoreMeta(settings).timezone,
            store: getStoreMeta(settings),
            staff: loginStaff,
            settings: publicSettings,
            tasks: [],
            oos: [],
            orders: [],
            orders_tv: [],
            kpis: {
                g: 0, f: 0, h: 0, staff: 0,
                g_hrs: '0.0', f_hrs: '0.0', h_hrs: '0.0',
                hrs_per_person: '0.0',
                shrinkTotal: '0.00',
                pieces_on_order: 0,
            },
        };
    }

    let counts = db.getCounts();
    if (!counts) {
        db.run('INSERT OR IGNORE INTO counts (id) VALUES (1)');
        counts = db.getCounts() ?? { grocery: 0, frozen: 0, hardware: 0, staff: 1 };
    }

    const cph = parseFloat(settings.Cases_Per_Hour) || 55;
    const hcph = parseFloat(settings.Hardware_CPH) || 50;
    const g = counts.grocery || 0;
    const f = counts.frozen || 0;
    const h = counts.hardware || 0;
    const staff = counts.staff || 1;
    const hwArrived = parseHardwareArrived(settings.Hardware_Arrived);
    const gH = g / cph;
    const fH = f / cph;
    const hH = hwArrived ? h / hcph : 0;
    const total = gH + fH + hH;
    const shrRow = isStaffAuth
        ? db.get("SELECT SUM(cost) as t FROM shrink_log WHERE status='Open'")
        : { t: 0 };
    const hwRow = isStaffAuth
        ? db.get("SELECT SUM(pieces) as t FROM expected_orders WHERE category='hardware' AND arrived=0")
        : { t: 0 };
    const shift = computeShiftMetrics(settings, counts);
    const kpis = {
        g, f, h, staff,
        g_hrs: gH.toFixed(1), f_hrs: fH.toFixed(1), h_hrs: hH.toFixed(1),
        hrs_per_person: (total / staff).toFixed(1),
        shrinkTotal: (shrRow?.t || 0).toFixed(2),
        pieces_on_order: hwRow?.t || 0,
        ...shift,
    };

    const warningDate = addDaysToDateStamp(today, 7);
    const killWarnings = db.all(`
        SELECT *, CAST(julianday(kill_date) - julianday(?) AS INTEGER) as days_until
        FROM kill_dates
        WHERE status='Active' AND kill_date>? AND kill_date<=?
        ORDER BY kill_date ASC
    `, today, today, warningDate);

    let health = {};
    if (isStaffAuth) {
        const dbPath = getDbPath();
        let dbSize = null;
        try { dbSize = fs.statSync(dbPath).size; } catch (_) { /* locked */ }
        health = {
            systemStats: { uptime: process.uptime(), memory: process.memoryUsage().heapUsed, dbSize },
            activeUsers: auth.listActiveSessions().map((s) => s.name),
        };
    }

    const staffData = listStaffForSync(db);
    const publicStaff = isStaffAuth ? staffData : staffData.map(publicStaffRow);

    const presenceConfig = loadPresenceConfig(db);
    const syncLogContext = {
        appVersion: APP_VERSION,
        storeDate: today,
        syncAudience: audience,
        sessionUser: session?.name || '',
        sessionRole: session?.role || '',
    };
    let managerMeta;
    let managerHubError = null;
    if (isManager) {
        try {
            managerMeta = buildManagerHubMeta(db, {
                today,
                clock,
                kpis,
                settings,
                cachedHeatMap,
                presenceConfig,
                getStoreDateStamp,
            });
        } catch (err) {
            managerHubError = err?.message || 'Manager hub unavailable';
            recordAppError('sync/manager_meta', managerHubError, err, syncLogContext, db);
        }
    }
    const presenceTv = buildPresenceTvSummary(db, presenceConfig);

    let dailyDirectionFloor = null;
    if (isManager && managerMeta?.daily_direction) {
        try {
            dailyDirectionFloor = buildDailyDirectionFloorView(managerMeta.daily_direction);
        } catch (err) {
            recordAppError('sync/daily_direction_floor', err?.message || 'Daily Direction floor failed', err, syncLogContext, db);
        }
    } else if (isAuth) {
        dailyDirectionFloor = loadDailyDirectionFloor(db, today);
    }

    const commsPayload = buildCommsSyncPayload(db, settings, {
        settings,
        storeDate: today,
        storeWeekday: clock.storeWeekday,
        storeTime: clock.storeTime,
        kpis,
    });

    const safety = buildSafetySyncPayload(db, today, { includeLibrary: isManager });

    if (isTv) {
        return buildTvSyncPayload({
            db,
            APP_VERSION,
            settings,
            tvDisplay,
            clock,
            today,
            kpis,
            killWarnings,
            commsPayload,
            safety,
            dailyDirectionFloor,
            presenceTv,
        });
    }

    let shiftLeadOptions;
    let activeManagerStale = false;
    let activeManagerWarning = null;
    if (isStaffAuth && (isManager || session?.role === 'Premium Clerk')) {
        try {
            const am = getActiveManagerStatus(db, today);
            settings.Active_Manager = am.value;
            publicSettings.Active_Manager = am.value;
            activeManagerStale = am.stale;
            if (am.stale) {
                activeManagerWarning = `${am.value} is set as shift lead but is not eligible today — pick a new lead.`;
                logWarn('sync/active_manager', activeManagerWarning, { storeDate: today, name: am.value }, db);
            }
            shiftLeadOptions = listShiftLeadOptions(db, today, { ensureNames: [session?.name] });
        } catch (err) {
            recordAppError('sync/shift_lead_options', err?.message || 'Shift lead options failed', err, syncLogContext, db);
            shiftLeadOptions = [];
        }
    }

    const storeWeekday = String(clock.storeWeekday || '').trim();
    const expectedToday = filterPendingExpectedForStoreDate(
        db.all("SELECT * FROM expected_orders WHERE status='Pending' AND category!='hardware'"),
        today,
        storeWeekday,
        getStoreDateStamp,
    );

    let receivingOnDock = [];
    let receivingOnDockError = null;
    let receivingDayLog = [];
    if (isStaffAuth) {
        try {
            receivingOnDock = attachPalletsToDockRows(db, db.all(`
                    SELECT * FROM expected_orders
                    WHERE category!='hardware' AND arrived=1
                      AND (departed_at IS NULL OR departed_at='')
                      AND status='Arrived'
                    ORDER BY datetime(arrived_at) DESC
                    LIMIT 40
                `));
        } catch (err) {
            receivingOnDockError = err?.message || 'Dock payload failed';
            recordAppError('sync/receiving_on_dock', receivingOnDockError, err, syncLogContext, db);
        }
        try {
            // Same store-local day match as /api/receiving/day-log (evening trucks).
            receivingDayLog = listReceivingDayLog(db, today);
        } catch (err) {
            recordAppError('sync/receiving_day_log', err?.message || 'Day log failed', err, syncLogContext, db);
            receivingDayLog = [];
        }
    }

    return {
        appVersion: APP_VERSION,
        /** True when the client sent x-session-token and it maps to a live staff/manager session. */
        sessionActive: sentToken && isStaffAuth,
        /** True when the client is an authorized trusted display/device. */
        deviceSessionActive: isTv,
        syncAudience: audience,
        tv_display: tvDisplay,
        deviceAuth: isTv ? { via: deviceAuth.via, label: trustedDevice?.label || null } : undefined,
        features: {
            trainingMode: false,
            unassignedLogin: isUnassignedOptionEnabled(settings),
            betacs: isCsFullEnabled(settings),
            csFull: isCsFullEnabled(settings),
            csHub: isCsHubEnabled(settings),
            csCrm: isCsCrmEnabled(settings) && isCsFullEnabled(settings),
            inventoryCount: isInventoryCountEnabled(settings),
            storeTransfers: isStoreTransfersEnabled(settings),
            messageCenter: isMessageCenterEnabled(settings),
            presence: loadPresenceConfig(db).enabled,
        },
        storeDate: today,
        storeWeekday: clock.storeWeekday,
        storeDateLabel: clock.storeDateLabel,
        storeTime: clock.storeTime,
        storeTimeSeconds: clock.storeTimeSeconds,
        storeTimezone: clock.storeTimezone || getStoreMeta(settings).timezone,
        store: getStoreMeta(settings),
        tasks: db.all(`
            SELECT * FROM tasks WHERE status='Open'
            ORDER BY
                CASE WHEN task_id LIKE 'AUTO-PULL-%' THEN 0 ELSE 1 END,
                CASE priority WHEN 'Urgent' THEN 1 WHEN 'High' THEN 2 ELSE 3 END,
                time_submitted
        `),
        oos: db.all("SELECT * FROM oos WHERE status='Open'"),
        ...buildOrderPayloadForAudience(db, audience),
        expected: expectedToday,
        receiving_vendor_options: isStaffAuth ? listCanonicalVendors(db) : [],
        receiving_on_dock: receivingOnDock,
        receiving_on_dock_error: isStaffAuth ? receivingOnDockError : undefined,
        receiving_day_log: isStaffAuth ? receivingDayLog : [],
        receiving_pallet_departments: isStaffAuth ? PALLET_DEPARTMENTS : [],
        expected_recent: isManager
            ? db.all("SELECT * FROM expected_orders WHERE category!='hardware' AND (status!='Pending' OR arrived=1) ORDER BY datetime(COALESCE(arrived_at,time_closed,expected_day)) DESC LIMIT 80")
            : [],
        hardware_orders: db.all("SELECT * FROM expected_orders WHERE category='hardware' ORDER BY arrived ASC, expected_day ASC LIMIT 400"),
        counts,
        settings: publicSettings,
        kpis,
        zoneHeatMap: cachedHeatMap,
        rhythm_tasks: db.all('SELECT * FROM rhythm_tasks ORDER BY day, detail'),
        vendor_schedule: db.all('SELECT * FROM vendor_schedule ORDER BY day, vendor'),
        staff: publicStaff,
        devices: isManager ? listTrustedDevicesSafe(db) : [],
        ticker: isMessageCenterEnabled(settings)
            ? mapTickerForLegacyClients(commsPayload)
            : db.all('SELECT * FROM ticker'),
        comms: commsPayload,
        shrink: db.all("SELECT * FROM shrink_log WHERE status='Open'"),
        kill_dates: db.all("SELECT * FROM kill_dates WHERE status='Active' ORDER BY kill_date ASC"),
        kill_warnings: killWarnings,
        staff_shifts: (isStaffAuth && (isManagerRole(session?.role) || session?.role === 'Premium Clerk'))
            ? db.all("SELECT * FROM staff_shifts WHERE shift_date BETWEEN ? AND date(?, '+14 day') ORDER BY shift_date, start_time, staff_name", today, today)
                // Bucket is computed here so Shift Roster and the rhythm engine can never disagree.
                .map((s) => ({ ...s, bucket: classifyShift(s.department, s.role, settings.Schedule_Role_Buckets || '') }))
            : [],
        shift_lead_options: shiftLeadOptions,
        active_manager_stale: activeManagerStale || undefined,
        active_manager_warning: activeManagerWarning || undefined,
        staff_name_aliases: isManager ? loadStaffNameAliases(db) : undefined,
        tasks_audit: isManager
            ? db.all(`
                    SELECT task_id, task_detail, status, priority, zone, assigned_to, est_mins,
                           time_submitted, time_closed, closed_by, start_time, related_id
                    FROM tasks
                    WHERE status IN ('Closed','Archived')
                    ORDER BY datetime(COALESCE(time_closed, time_submitted)) DESC
                    LIMIT 120
                `)
            : [],
        markdown_archive_count: isManager
            ? (db.get("SELECT COUNT(*) as c FROM kill_dates WHERE status != 'Active'")?.c ?? 0)
            : undefined,
        audit: isManager ? db.all("SELECT user, action_type||' on '||target_table as event, timestamp as time FROM audit_ledger ORDER BY timestamp DESC LIMIT 10") : [],
        health,
        manager_meta: managerMeta,
        manager_hub_error: managerHubError || undefined,
        sync_diagnostics: isManager ? {
            last_sync_error: readSettingJson(db, 'Sync_Last_Error', null),
            manager_hub_boot: readSettingJson(db, 'Manager_Hub_Boot_Status', null),
        } : undefined,
        daily_direction_floor: dailyDirectionFloor,
        morning_rhythm: (isStaffAuth && (isManager || session?.role === 'Premium Clerk'))
            ? buildMorningRhythmStatus(db, {
                getStoreDateStamp,
                getStoreClockPayload,
                storeTime: clock.storeTime,
                getTimezone: () => clock.storeTimezone,
            })
            : undefined,
        daily_safety_focus: safety.focus,
        safety_blurbs: isManager ? safety.blurbs : undefined,
        presence_tv: presenceTv,
        ocr_mode: process.env.TGP_OCR_MODE || 'local',
    };
}

module.exports = {
    assembleSyncPayload,
    resolveSyncAudience,
    redactSettingsForAudience,
    publicStaffRow,
    buildOrderPayloadForAudience,
    authorizeTvSyncRequest,
};
