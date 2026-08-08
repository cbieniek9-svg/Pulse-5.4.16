import { fetchJson, formatApiError, httpError, resolveUrl } from './api.js';
import { postAction } from './actions.js';
import { genId, storeToday, upperCase } from './floorUtils.js';

export async function postJson(path, body, token) {
    const payload = body && typeof body === 'object' ? { ...body } : {};
    if (token) payload.token = token;
    return fetchJson(path, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'x-session-token': token } : {}),
        },
        body: JSON.stringify(payload),
    });
}

export async function fetchAuthenticatedExport(url, { format = 'print', filename = 'export.csv', printWindow = null, token } = {}) {
    const res = await fetch(resolveUrl(url), {
        headers: { 'x-session-token': token || '' },
    });
    if (!res.ok) throw await httpError(res, `Export failed (${res.status})`);

    if (format === 'csv') {
        const blob = await res.blob();
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
        return;
    }

    const html = await res.text();
    const win = printWindow && !printWindow.closed ? printWindow : window.open('', '_blank');
    if (!win) throw new Error('Popup blocked. Allow popups for this app and try again.');
    win.document.open();
    win.document.write(html);
    win.document.close();
    try { win.focus(); } catch (_) { /* ignore */ }
}

export async function downloadProtectedFile(path, filename, token) {
    const res = await fetch(resolveUrl(path), {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(token ? { 'x-session-token': token } : {}),
        },
        body: JSON.stringify({ token }),
    });
    if (!res.ok) throw await httpError(res, 'Download failed');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(await res.blob());
    a.download = filename;
    a.click();
}

export function createFloorActions({ token, user, sync, postActionFn, showNotice, appConfirm, appPrompt, appOrderFinishGate, syncData }) {
    const userContext = user ? { name: user, token } : null;
    const today = () => storeToday(syncData);

    const api = async (table, action, data, id_col, id_val) => {
        await postActionFn({ table, action, data, id_col, id_val });
    };

    return {
        manualTask: async ({ desc, priority, zone }) => {
            if (!desc?.trim()) return false;
            await api('tasks', 'insert', {
                task_id: genId('T'),
                task_detail: upperCase(desc),
                priority: priority || 'Routine',
                zone: zone || 'General',
                status: 'Open',
                assigned_to: 'Unassigned',
            });
            return true;
        },
        logOos: async ({ zone, count, notes }) => {
            await api('oos', 'insert', {
                oos_id: genId('O'),
                zone: zone || 'General',
                hole_count: parseInt(count, 10) || 1,
                notes: upperCase(notes || ''),
                status: 'Open',
            });
            return true;
        },
        updateOpsData: async ({ grocery, frozen, staff, hardware, frozen_staff }) => {
            const data = {
                grocery: Number(grocery || 0),
                frozen: Number(frozen || 0),
                staff: Number(staff || 0),
                hardware: Number(hardware || 0),
            };
            if (frozen_staff != null) data.frozen_staff = Number(frozen_staff || 0);
            await api('counts', 'update', data, 'id', 1);
        },
        toggleHardwareArrived: async (checked) => {
            await api('settings', 'update', { setting_value: checked ? '1' : '0' }, 'setting_name', 'Hardware_Arrived');
        },
        startOrder: async () => {
            if (syncData?.settings?.Order_End) {
                throw new Error('Dry clock is stuck (FINISH set). Use Clear stuck clock first.');
            }
            if (!(await appConfirm('Start the DRY (grocery) order clock now?'))) return false;
            await api('settings', 'update', { setting_value: new Date().toISOString() }, 'setting_name', 'Order_Start');
            return true;
        },
        startFrozenOrder: async () => {
            if (syncData?.settings?.Frozen_Order_End) {
                throw new Error('Frozen clock is stuck (FINISH set). Use Clear stuck clock first.');
            }
            if (syncData?.settings?.Frozen_Order_Start) {
                throw new Error('Frozen clock is already running.');
            }
            if (!(await appConfirm('Start the FROZEN order clock now? (manual — enter frozen crew on FINISH)'))) return false;
            await api('settings', 'update', { setting_value: new Date().toISOString() }, 'setting_name', 'Frozen_Order_Start');
            return true;
        },
        endOrder: async (payload = {}) => {
            const clockKind = payload.clock_kind === 'frozen' ? 'frozen' : 'dry';
            let gate = payload;
            if (payload.staff_count == null && typeof appOrderFinishGate === 'function') {
                gate = await appOrderFinishGate({ clockKind });
                if (!gate) return false;
            } else if (payload.staff_count == null) {
                const counts = syncData?.counts || {};
                const kpis = syncData?.kpis || {};
                const staffDefault = clockKind === 'frozen'
                    ? (Number(counts.frozen_staff || 0) || Number(counts.staff || 0) || 1)
                    : (Number(counts.staff || 0) || Number(kpis.order_staff || kpis.staff || 0) || 1);
                const label = clockKind === 'frozen' ? 'Frozen crew headcount:' : 'Dry staff on order (headcount):';
                const staffInput = await appPrompt(label, String(staffDefault));
                if (staffInput == null) return false;
                gate = {
                    staff_count: Math.max(1, parseInt(staffInput, 10) || staffDefault),
                    hardware_arrived: syncData?.settings?.Hardware_Arrived === '1',
                    exception_reason: '',
                    clock_kind: clockKind,
                };
            }
            const staff_count = Math.max(1, parseInt(gate.staff_count, 10) || 1);
            if (staff_count > 99) throw new Error('Staff on order must be 1–99');
            const hardware_arrived = gate.hardware_arrived === true || gate.hardware_arrived === '1' || gate.hardware_arrived === 1;
            const exception_reason = String(gate.exception_reason || '').trim().slice(0, 200);
            await postJson('/api/order-finish', {
                staff_count,
                hardware_arrived: clockKind === 'dry' ? hardware_arrived : false,
                exception_reason: exception_reason || undefined,
                clock_kind: clockKind,
            }, token);
            await sync(true);
            return true;
        },
        resetOrderClock: async () => {
            if (!(await appConfirm('Clear stuck DRY and FROZEN order clocks? Use only when FINISH was set but board still shows in progress.'))) return false;
            await postJson('/api/order-clock-reset', { token }, token);
            await sync(true);
            return true;
        },
        saveShiftNotes: async ({ notes, critical }) => {
            await postJson('/api/settings-batch', {
                settings: [
                    { setting_name: 'Shift_Notes', setting_value: notes },
                    { setting_name: 'Critical_Alert', setting_value: critical ? '1' : '0' },
                ],
            }, token);
            await sync(true);
            return true;
        },
        sendTicker: async (message) => {
            if (!message?.trim()) return false;
            await api('ticker', 'insert', { msg_id: genId('M'), message: upperCase(message) });
            return true;
        },
        deleteTicker: async (msgId) => {
            await api('ticker', 'delete', {}, 'msg_id', msgId);
            return true;
        },
        clearAllTickers: async () => {
            if (!syncData?.ticker?.length) return false;
            if (!(await appConfirm('Remove all ticker messages from the scroll?'))) return false;
            await postJson('/api/clear-ticker', { userContext }, token);
            await sync(true);
            return true;
        },
        postComms: async (lane, body, extra = {}) => {
            await postJson('/api/comms/post', {
                lane,
                body: upperCase(body),
                priority: extra.priority,
                zone: extra.zone || '',
                expires_hours: extra.expires_hours,
                userContext,
            }, token);
            await sync(true);
        },
        clearCommsLane: async (lane) => {
            const label = lane === 'pinned' ? 'pinned messages' : `${lane} lane`;
            if (!(await appConfirm(`Clear all ${label}?`))) return;
            await postJson('/api/comms/clear-lane', { lane, userContext }, token);
            await sync(true);
        },
        toggleMessageCenter: async (enabled, systemMessages) => {
            const msg = enabled
                ? 'Enable Message Center? Legacy shift notes / ticker panel will be hidden.'
                : 'Switch back to legacy comms? Message Center panels will hide; legacy textarea + ticker returns.';
            if (!(await appConfirm(msg))) return false;
            await postJson('/api/comms/set-mode', {
                enabled,
                system_messages: systemMessages !== false,
                userContext,
            }, token);
            await sync(true);
            return true;
        },
        setCommsSystemMode: async (systemMessages, messageCenterEnabled) => {
            await postJson('/api/comms/set-mode', {
                enabled: messageCenterEnabled !== false,
                system_messages: systemMessages,
                userContext,
            }, token);
            await sync(true);
        },
        setActiveManager: async (val) => {
            await postJson('/api/action', {
                table: 'settings',
                action: 'update',
                data: { setting_value: val },
                id_col: 'setting_name',
                id_val: 'Active_Manager',
                userContext,
            }, token);
            await sync(true);
        },
        updateShiftSchedule: async (shiftId, department) => {
            // Send department only — it now outranks the imported job title, so the title is kept.
            await postJson('/api/staff-shifts/update', { id: shiftId, department, token }, token);
            await sync(true);
        },
        reapplyRhythmAssignments: async () => {
            if (!(await appConfirm('Update assignees on open board tasks from the current schedule?'))) return;
            const result = await postJson('/api/rhythm/reapply-assignments', { token }, token);
            const msg = result.updated
                ? `Updated ${result.updated} of ${result.total} open tasks`
                : 'No open tasks needed reassignment';
            showNotice(msg, 'success');
            await sync(true);
        },
        loadRhythm: async () => {
            if (!(await appConfirm("Load today's schedule?"))) return false;
            let res = await postJson('/api/daily-rhythm', { token }, token);
            // Concurrent heal returns busy — retry without force (server tops up if incomplete).
            // Never auto-force: when openToday=0, force clears the stamp and full-reseeds.
            if (res.busy) {
                await new Promise((r) => setTimeout(r, 400));
                res = await postJson('/api/daily-rhythm', { token }, token);
            } else if (res.alreadyLoaded && !res.success) {
                if (await appConfirm('Schedule already marked loaded. Force add any missing rhythm tasks?')) {
                    res = await postJson('/api/daily-rhythm', { token, force: true }, token);
                } else {
                    await sync(true);
                    return false;
                }
            }
            await sync(true);
            if (res.inserted === false && res.reason) showNotice(res.reason, 'info');
            else if (res.success) {
                const n = res.tasks || 0;
                const top = res.toppedUp ? ' (top-up)' : '';
                showNotice(n ? `Schedule loaded — ${n} task${n === 1 ? '' : 's'}${top}` : 'Nothing scheduled for today', n ? 'success' : 'info');
            } else if (res.skipped) showNotice(res.reason || 'Schedule already on board', 'info');
            else if (res.alreadyLoaded) {
                const n = res.openTasks || 0;
                const note = res.carryoverOpen ? ` — ${res.carryoverOpen} carryover still open` : '';
                showNotice(`Schedule already loaded (${n} open today${note})`, 'info');
            } else if (res.error) showNotice(res.error, 'error');
            return true;
        },
        premiumZoneRecovery: async (check) => {
            const res = await postJson('/api/premium-zone-recovery', { check, token }, token);
            const assignee = res.assignee && res.assignee !== 'Unassigned' ? ` → ${res.assignee}` : '';
            showNotice(`${res.tasksCreated} recovery task(s) posted${assignee}`, 'success');
            await sync(true);
        },
        submitAudit: async (audit) => {
            const res = await postJson('/api/homebase-audits', { audit }, token);
            if (res.success) await sync(true);
            return res;
        },
        saveDailyDirectionDraft: async (payload) => {
            await postJson('/api/daily-direction/save', { token, ...payload }, token);
            await sync(true);
        },
        approveDailyDirection: async (payload) => {
            if (!(await appConfirm('Approve and post Daily Direction to the board?'))) return false;
            await postJson('/api/daily-direction/approve', { token, ...payload }, token);
            await sync(true);
            return true;
        },
        updatePostedDailyDirection: async (payload) => {
            if (!payload.floor_message) throw new Error('Enter a floor message');
            if (!(await appConfirm('Replace the visible Daily Direction on the board?'))) return false;
            await postJson('/api/daily-direction/update-posted', { token, ...payload }, token);
            await sync(true);
            return true;
        },
        ignoreDailyDirectionAmendment: async (minutes = 120) => {
            await postJson('/api/daily-direction/amendment/ignore', { token, minutes }, token);
            await sync(true);
            return true;
        },
        dismissDailyDirectionAmendment: async (fingerprint) => {
            if (!fingerprint) throw new Error('Amendment fingerprint is required');
            await postJson('/api/daily-direction/amendment/dismiss', { token, fingerprint }, token);
            await sync(true);
            return true;
        },
        saveDailyDirectionShiftUpdateDraft: async (message) => {
            const trimmed = String(message || '').trim();
            if (!trimmed) throw new Error('Enter a Daily Direction update');
            await postJson('/api/daily-direction/shift-update/save', { token, message: trimmed }, token);
            await sync(true);
            return true;
        },
        postDailyDirectionShiftUpdate: async ({ message, fingerprint, triggers } = {}) => {
            const trimmed = String(message || '').trim();
            if (!trimmed) throw new Error('Nothing to update — edit Daily Direction first');
            if (!(await appConfirm('Update the visible Daily Direction? This will replace the TV message and keep the update in reports.'))) {
                return false;
            }
            await postJson('/api/daily-direction/shift-update/post', {
                token,
                message: trimmed,
                fingerprint: fingerprint || undefined,
                triggers: triggers || undefined,
            }, token);
            await sync(true);
            return true;
        },
        ackReportAction: async (actionId) => {
            await postJson('/api/reports/ack-action', {
                token,
                action_id: actionId,
                report_date: today(),
            }, token);
            await sync(true);
        },
        deferRhythm: async (storeDate, rhythmIds) => {
            await postJson('/api/reports/defer-rhythm', { token, store_date: storeDate, rhythm_ids: rhythmIds }, token);
            await sync(true);
            return true;
        },
        markKillResolved: async (id, kind) => {
            const msg = kind === 'sold'
                ? 'Mark this item as sold through? It will leave the expiry board and no pull task will be created.'
                : 'Mark this item as pulled? It will leave the live expiry board.';
            if (!(await appConfirm(msg))) return;
            await api('kill_dates', 'update', { status: 'Closed' }, 'id', id);
            await sync(true);
        },
        clearMarkdownArchive: async () => {
            const archived = syncData?.markdown_archive_count ?? 0;
            if (!archived) {
                showNotice('No archived markdown rows to clear.', 'success');
                return;
            }
            if (!(await appConfirm(
                `Remove ${archived} archived markdown/expiry record${archived === 1 ? '' : 's'} from the database?\n\nActive items on the TV board and markdown portal will stay.`,
            ))) return;
            await postJson('/api/clear-markdown-db', { userContext }, token);
            await sync(true);
        },
        presenceToggle: async (checked) => {
            await postJson('/api/presence/config', { token, enabled: !!checked }, token);
            await sync(true);
        },
        presenceAssetMode: async (mode) => {
            await postJson('/api/presence/config', { token, asset_mode: mode }, token);
            await sync(true);
        },
        presenceSeedDemo: async () => {
            await postJson('/api/presence/seed-demo-carts', { token, count: 8 }, token);
            await sync(true);
        },
        presenceEnableAisle: async () => {
            await postJson('/api/presence/enable-aisle-template', { token }, token);
            await sync(true);
        },
        presenceRotateKey: async () => {
            if (!(await appConfirm('Rotate gateway key? Update every ESP32 / hub with the new key shown next.'))) return;
            const res = await postJson('/api/presence/rotate-key', { token }, token);
            if (res.gateway_key) {
                try { await navigator.clipboard?.writeText(res.gateway_key); } catch (_) { /* ignore */ }
            }
            await sync(true);
            return res;
        },
        presenceDiscovery: async (on) => {
            await postJson('/api/presence/config', { token, allow_discovery: !!on }, token);
            await sync(true);
        },
        presenceRegisterAsset: async ({ beaconId, label, assetType }) => {
            await postJson('/api/presence/assets', {
                token,
                beacon_id: beaconId,
                asset_type: assetType,
                label: label || beaconId,
            }, token);
            await sync(true);
        },
        markRecvTimeIn: async (expId) => {
            if (!(await appConfirm('Log TIME IN for this vendor?'))) return false;
            await postJson('/api/action', {
                table: 'expected_orders',
                action: 'receiving_mark_arrived',
                data: {},
                id_col: 'exp_id',
                id_val: expId,
                userContext,
            }, token);
            await sync(true);
            return true;
        },
        markHardwareArrive: async (expId) => {
            if (!(await appConfirm('Mark this hardware order arrived? Pieces add to the HARDWARE count.'))) {
                return false;
            }
            await postJson('/api/action', {
                table: 'expected_orders',
                action: 'hardware_arrive',
                data: {},
                id_col: 'exp_id',
                id_val: expId,
                userContext,
            }, token);
            await sync(true);
            return true;
        },
        markHardwareUnarrive: async (expId) => {
            if (!(await appConfirm('Undo hardware arrival? Pieces come off the HARDWARE count.'))) {
                return false;
            }
            await postJson('/api/action', {
                table: 'expected_orders',
                action: 'hardware_unarrive',
                data: {},
                id_col: 'exp_id',
                id_val: expId,
                userContext,
            }, token);
            await sync(true);
            return true;
        },
        markRecvTimeOut: async (expId, data) => {
            await postJson('/api/action', {
                table: 'expected_orders',
                action: 'receiving_mark_departed',
                data,
                id_col: 'exp_id',
                id_val: expId,
                userContext,
            }, token);
            await sync(true);
        },
        removePendingDelivery: async (expId) => {
            if (!(await appConfirm('Remove this pending delivery? Use for duplicates / ghost vendors only.'))) return;
            await postJson('/api/action', {
                table: 'expected_orders',
                action: 'update',
                data: { status: 'Archived' },
                id_col: 'exp_id',
                id_val: expId,
                userContext,
            }, token);
            await sync(true);
        },
        logAdhocArrival: async (vendor, createTask) => {
            await postJson('/api/action', {
                table: 'expected_orders',
                action: 'receiving_log_arrival',
                data: {
                    vendor: String(vendor).trim(),
                    create_task: createTask ? '1' : '0',
                    expected_day: today(),
                },
                userContext,
            }, token);
            await sync(true);
        },
        assignTask: async (taskId, assignee) => {
            if (taskId && assignee) {
                await api('tasks', 'update', { assigned_to: assignee }, 'task_id', taskId);
            }
        },
        deleteTask: async (taskId) => {
            if (!(await appConfirm('Delete this task from the board?'))) return;
            await api('tasks', 'delete', {}, 'task_id', taskId);
        },
        triggerEodSweep: async () => {
            if (!(await appConfirm('Archive the board?'))) return false;
            try {
                const result = await postJson('/api/eod-sweep', {}, token);
                await sync(true);
                return result && typeof result === 'object' ? result : { success: true };
            } catch (e) {
                throw new Error(formatApiError(e, e.message || 'EOD sweep failed'));
            }
        },
        triggerClearDb: async () => {
            if (!(await appConfirm('WIPE ALL DATA? This cannot be undone.'))) return false;
            await postJson('/api/clear-db', {}, token);
            await sync(true);
            return true;
        },
        exportReceivingLog: async (day, format, tokenArg) => {
            const fmt = format === 'csv' ? 'csv' : 'print';
            const url = `/api/export/receiving-log?date=${encodeURIComponent(day)}&format=${fmt}`;
            const printWindow = fmt === 'print' ? window.open('', '_blank') : null;
            if (printWindow) {
                printWindow.document.write('<!doctype html><title>Receiving Log</title><body style="font-family:Arial,sans-serif;margin:24px">Loading receiving log…</body>');
                printWindow.document.close();
            }
            await fetchAuthenticatedExport(url, {
                format: fmt,
                filename: `Receiving_Log_${day}.csv`,
                printWindow,
                token: tokenArg || token,
            });
        },
        exportKillDatePullList: async (format) => {
            const fmt = format === 'csv' ? 'csv' : 'print';
            const url = `/api/export/kill-dates?format=${fmt}`;
            const printWindow = fmt === 'print' ? window.open('', '_blank') : null;
            if (printWindow) {
                printWindow.document.write('<!doctype html><title>Expiry Pull List</title><body style="font-family:Arial,sans-serif;margin:24px">Loading expiry pull list…</body>');
                printWindow.document.close();
            }
            await fetchAuthenticatedExport(url, {
                format: fmt,
                filename: `Expiry_Pull_List_${today()}.csv`,
                printWindow,
                token,
            });
        },
        exportAudits: async (query) => {
            await fetchAuthenticatedExport(`/api/export/audits${query ? `?${query}` : ''}`, {
                format: 'csv',
                filename: 'HomeBase_Audits.csv',
                token,
            });
        },
        exportWeeklyTrends: async () => {
            await fetchAuthenticatedExport('/api/export/weekly-trends', {
                format: 'csv',
                filename: 'Weekly_Trends.csv',
                token,
            });
        },
        downloadProtectedFile: (path, filename) => downloadProtectedFile(path, filename, token),
        dismissComms: async (msgId) => {
            await postJson('/api/comms/dismiss', { msg_id: msgId, userContext }, token);
            await sync(true);
        },
        promoteComms: async (msgId) => {
            await postJson('/api/comms/promote', { msg_id: msgId, userContext }, token);
            await sync(true);
        },
    };
}

export { postAction };
