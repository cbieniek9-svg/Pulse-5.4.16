/** Mirrors public/js/mobile/stream.js handleDelta KEY_MAP and mutation rules (immutable). */

export const URGENT_DELTA_TABLES = new Set([
    'tasks', 'expected_orders', 'oos', 'special_orders', 'kill_dates', 'counts', 'ticker', 'comms_messages',
]);

export const KEY_MAP = {
    tasks: 'tasks',
    oos: 'oos',
    special_orders: 'orders',
    expected_orders: 'expected',
    staff: 'staff',
    ticker: 'ticker',
    shrink_log: 'shrink',
    kill_dates: 'kill_dates',
    counts: 'counts',
    settings: 'settings',
    rhythm_tasks: 'rhythm_tasks',
    vendor_schedule: 'vendor_schedule',
    staff_shifts: 'staff_shifts',
    trusted_devices: 'devices',
};

const DEFAULT_KPIS = {
    g: 0, f: 0, h: 0, staff: 1,
    g_hrs: '0.0', f_hrs: '0.0', h_hrs: '0.0',
    hrs_per_person: '0.0', shrinkTotal: '0.00', pieces_on_order: 0,
};

const DEFAULT_COUNTS = { grocery: 0, frozen: 0, hardware: 0, staff: 1 };

/** Normalize partial /api/sync payloads (same defensive defaults as renderData). */
export function normalizeSyncData(data) {
    if (!data) return null;
    return {
        ...data,
        tasks: data.tasks || [],
        oos: data.oos || [],
        orders: data.orders || [],
        expected: data.expected || [],
        expected_recent: data.expected_recent || [],
        hardware_orders: data.hardware_orders || [],
        receiving_on_dock: data.receiving_on_dock || [],
        kill_dates: data.kill_dates || [],
        kill_warnings: data.kill_warnings || [],
        staff_shifts: data.staff_shifts || [],
        ticker: data.ticker || [],
        comms: data.comms || { enabled: false },
        shrink: data.shrink || [],
        audit: data.audit || [],
        devices: data.devices || [],
        daily_safety_focus: data.daily_safety_focus || null,
        kpis: data.kpis || { ...DEFAULT_KPIS },
        counts: data.counts || { ...DEFAULT_COUNTS },
        settings: data.settings || {},
        zoneHeatMap: data.zoneHeatMap || {},
        staff: data.staff || [],
    };
}

/** Replace local state with a full sync payload. */
export function applySyncPayload(_state, data) {
    if (!data?.staff) return _state;
    return normalizeSyncData(data);
}

/**
 * Apply one SSE delta. Returns updated state and whether a full sync is needed.
 * @returns {{ state: object|null, needsSync: boolean, urgent?: boolean }}
 */
export function applyDelta(state, delta) {
    if (!state || !delta?.table) {
        return { state, needsSync: true, urgent: true };
    }

    const { table, action, data, id_col, id_val } = delta;
    const urgent = URGENT_DELTA_TABLES.has(table);
    const actionStr = String(action || '');

    // Composite sync fields (morning_rhythm, manager_meta.daily_direction) only assemble
    // on full /api/sync — force refresh after rhythm heal or DD mutations.
    if (
        table === 'daily_direction'
        || table === 'shift_updates'
        || (table === 'tasks' && /rhythm/i.test(actionStr))
    ) {
        return { state, needsSync: true, urgent: true };
    }

    if (table === 'expected_orders') {
        return { state, needsSync: true, urgent: true };
    }

    const key = KEY_MAP[table];
    if (!key || state[key] === undefined) {
        return { state, needsSync: true, urgent };
    }

    try {
        if (key === 'counts' || key === 'settings') {
            if (data && typeof data === 'object') {
                return {
                    state: { ...state, [key]: { ...state[key], ...data } },
                    needsSync: false,
                };
            }
            return { state, needsSync: true, urgent };
        }

        if (action === 'insert' && data) {
            if (Array.isArray(state[key])) {
                return {
                    state: { ...state, [key]: [...state[key], data] },
                    needsSync: false,
                };
            }
            return { state, needsSync: true, urgent };
        }

        if (action === 'update' && id_col && id_val != null) {
            const arr = state[key];
            if (!Array.isArray(arr)) return { state, needsSync: true, urgent };

            const idx = arr.findIndex((x) => String(x[id_col]) === String(id_val));
            if (idx >= 0) {
                const terminalTask = key === 'tasks' && data?.status === 'Closed';
                const terminalKill = key === 'kill_dates' && data?.status && data.status !== 'Active';

                if (terminalTask) {
                    return {
                        state: { ...state, [key]: arr.filter((_, i) => i !== idx) },
                        needsSync: false,
                    };
                }

                if (terminalKill) {
                    const nextKillDates = arr.filter((_, i) => i !== idx);
                    const nextKillWarnings = Array.isArray(state.kill_warnings)
                        ? state.kill_warnings.filter((w) => String(w.id) !== String(id_val))
                        : state.kill_warnings;
                    return {
                        state: {
                            ...state,
                            kill_dates: nextKillDates,
                            kill_warnings: nextKillWarnings,
                        },
                        needsSync: false,
                    };
                }

                const nextArr = [...arr];
                nextArr[idx] = { ...nextArr[idx], ...data };
                return { state: { ...state, [key]: nextArr }, needsSync: false };
            }

            if (key === 'tasks') {
                return { state, needsSync: false };
            }
            if (key === 'staff_shifts' || key === 'devices') {
                return { state, needsSync: true, urgent };
            }
            return { state, needsSync: true, urgent };
        }

        if (action === 'delete' && id_col && id_val != null) {
            if (Array.isArray(state[key])) {
                return {
                    state: {
                        ...state,
                        [key]: state[key].filter((x) => String(x[id_col]) !== String(id_val)),
                    },
                    needsSync: false,
                };
            }
            return { state, needsSync: true, urgent };
        }

        return { state, needsSync: true, urgent };
    } catch (e) {
        console.error('[DELTA]', e.message);
        return { state, needsSync: true, urgent: true };
    }
}

/**
 * Optimistic local updates before /api/action completes (mirrors network.js applyOptimisticAction).
 * @returns {object|null} next state, or null if no optimistic change applied
 */
export function applyOptimisticAction(state, table, action, data, id_col, id_val) {
    if (!state) return null;

    if (action === 'update' && (data?.status === 'Closed' || data?.status === 'Complete')) {
        if (table === 'tasks' && id_col === 'task_id' && id_val != null) {
            let next = {
                ...state,
                tasks: (state.tasks || []).filter((t) => String(t.task_id) !== String(id_val)),
            };
            if (String(id_val).startsWith('AUTO-PULL-')) {
                const killId = String(id_val).slice('AUTO-PULL-'.length);
                next = {
                    ...next,
                    kill_dates: (next.kill_dates || []).filter((k) => String(k.id) !== killId),
                    kill_warnings: Array.isArray(next.kill_warnings)
                        ? next.kill_warnings.filter((w) => String(w.id) !== killId)
                        : next.kill_warnings,
                };
            }
            return next;
        }
        if (table === 'oos' && id_col === 'oos_id' && id_val != null) {
            return {
                ...state,
                oos: (state.oos || []).filter((o) => String(o.oos_id) !== String(id_val)),
            };
        }
        if (table === 'special_orders' && id_col === 'order_id' && id_val != null) {
            return {
                ...state,
                orders: (state.orders || []).filter((o) => String(o.order_id) !== String(id_val)),
            };
        }
    }

    if (action === 'delete' && table === 'tasks' && id_col === 'task_id' && id_val != null) {
        return {
            ...state,
            tasks: (state.tasks || []).filter((t) => String(t.task_id) !== String(id_val)),
        };
    }

    if (action === 'delete' && table === 'ticker' && id_col === 'msg_id' && id_val != null) {
        return {
            ...state,
            ticker: (state.ticker || []).filter((t) => String(t.msg_id) !== String(id_val)),
        };
    }

    if (action === 'insert' && table === 'ticker' && data?.msg_id) {
        const ticker = Array.isArray(state.ticker) ? [...state.ticker] : [];
        ticker.push({ msg_id: data.msg_id, message: data.message || '' });
        return { ...state, ticker };
    }

    return null;
}
