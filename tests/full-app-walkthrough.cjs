'use strict';

const ExcelJS = require('exceljs');
const {
    BASE, CS, waitForServer, request, json, managerToken, readManagerCredentials, uid, WalkthroughRunner,
} = require('./helpers/api-client.cjs');

const run = new WalkthroughRunner();
const cleanup = { tasks: [], oos: [], kills: [], orders: [], expected: [] };

async function main() {
    console.log('\n=== TGP FULL APP API WALKTHROUGH ===\n');
    console.log(`Target: ${BASE}\n`);

    let token;
    let sync;
    let MANAGER;

    try {
        await waitForServer();
        run.ok('Server reachable');
    } catch (e) {
        run.bad('Server reachable', e);
        return exit();
    }

    // ── Portals ─────────────────────────────────────────────────────────────
    for (const [name, p] of [
        ['Mobile hub', '/'],
        ['CS portal', '/cs'],
        ['Receiving', '/rec'],
        ['Inventory Count', '/count'],
        ['Markdown', '/markdown'],
        ['Reports', '/reports'],
        ['Settings Editor', '/settings'],
        ['TV native shell', '/public/tv/tv-dashboard.html'],
    ]) {
        try {
            const r = await fetch(`${BASE}${p}`);
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
            run.ok(`Portal loads: ${name}`);
        } catch (e) {
            run.bad(`Portal loads: ${name}`, e);
        }
    }

    try {
        const redir = await request('GET', '/betacs', { raw: true });
        if (redir.status !== 301) throw new Error(`expected 301, got ${redir.status}`);
        run.ok('/betacs redirects to /cs');
    } catch (e) {
        run.bad('/betacs redirects to /cs', e);
    }

    // ── Security gates ──────────────────────────────────────────────────────
    try {
        const r = await request('POST', '/api/action', {
            body: { table: 'staff', action: 'update', id_col: 'id', id_val: 1, data: { active: 0 }, userContext: { name: 'CHRIS' } },
        });
        if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
        run.ok('Privileged action blocked without auth');
    } catch (e) {
        run.bad('Privileged action blocked without auth', e);
    }

    try {
        const r = await request('GET', '/api/health');
        if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
        run.ok('Health endpoint requires session');
    } catch (e) {
        run.bad('Health endpoint requires session', e);
    }

    try {
        const r = await request('GET', '/api/reports');
        if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
        run.ok('Reports API requires session');
    } catch (e) {
        run.bad('Reports API requires session', e);
    }

    // ── Auth + sync shape ───────────────────────────────────────────────────
    try {
        sync = await json('GET', '/api/sync');
        for (const key of ['appVersion', 'tasks', 'oos', 'orders', 'orders_tv', 'staff', 'settings', 'kpis', 'features']) {
            if (sync[key] === undefined) throw new Error(`sync missing ${key}`);
        }
        run.ok('Anonymous sync payload shape', sync.appVersion);
    } catch (e) {
        run.bad('Anonymous sync payload shape', e);
    }

    try {
        MANAGER = readManagerCredentials();
        const auth = await json('POST', '/api/mobile-auth', { name: MANAGER.name, pin: MANAGER.pin });
        token = auth.token;
        if (!token) throw new Error('manager token missing');
        run.ok('Manager auth (paired fixture)', MANAGER.name);
    } catch (e) {
        run.bad('Manager auth (paired fixture)', e);
        return exit();
    }

    try {
        await json('GET', '/api/health', null, token);
        run.ok('Health endpoint (authenticated)');
    } catch (e) {
        run.bad('Health endpoint (authenticated)', e);
    }

    try {
        sync = await json('GET', '/api/sync', null, token);
        if (typeof sync.markdown_archive_count !== 'number') throw new Error('manager fields missing');
        if (!Array.isArray(sync.devices)) throw new Error('devices missing');
        if (!Array.isArray(sync.tasks_audit)) throw new Error('tasks_audit missing');
        run.ok('Manager sync payload');
    } catch (e) {
        run.bad('Manager sync payload', e);
    }

    // ── Betacs config ───────────────────────────────────────────────────────
    try {
        await json('POST', '/api/action', {
            table: 'settings', action: 'update', data: { setting_value: '1' },
            id_col: 'setting_name', id_val: 'Betacs_Enabled',
            userContext: { ...MANAGER, token },
        });
        const cfg = await json('GET', '/api/cs/config');
        if (!cfg.betacs) throw new Error('betacs not enabled');
        run.ok('Betacs suite enabled via settings');
    } catch (e) {
        run.bad('Betacs suite enabled via settings', e);
    }

    // ── Floor ops ───────────────────────────────────────────────────────────
    const taskId = uid('T-FULL');
    cleanup.tasks.push(taskId);
    try {
        await json('POST', '/api/action', {
            table: 'tasks', action: 'insert',
            data: { task_id: taskId, task_detail: 'FULL WALKTHROUGH TASK', status: 'Open', priority: 'High', zone: 'A5', assigned_to: 'Unassigned', est_mins: 15 },
            userContext: { ...MANAGER, token },
        });
        run.ok('Insert task');
    } catch (e) {
        run.bad('Insert task', e);
    }

    const oosId = uid('OOS');
    cleanup.oos.push(oosId);
    try {
        await json('POST', '/api/action', {
            table: 'oos', action: 'insert',
            data: { oos_id: oosId, zone: 'A1', hole_count: 3, status: 'Open' },
            userContext: { ...MANAGER, token },
        });
        run.ok('Insert OOS');
    } catch (e) {
        run.bad('Insert OOS', e);
    }

    try {
        await json('POST', '/api/action', {
            table: 'ticker', action: 'insert',
            data: { msg_id: uid('M'), message: 'FULL WALKTHROUGH TICKER' },
            userContext: { ...MANAGER, token },
        });
        run.ok('Insert ticker');
    } catch (e) {
        run.bad('Insert ticker', e);
    }

    try {
        await json('POST', '/api/action', {
            table: 'counts', action: 'update', id_col: 'id', id_val: 1,
            data: { grocery: 10, frozen: 5, hardware: 2, staff: 2 },
            userContext: { ...MANAGER, token },
        });
        run.ok('Update labor counts');
    } catch (e) {
        run.bad('Update labor counts', e);
    }

    try {
        await json('POST', '/api/action', {
            table: 'settings', action: 'update', id_col: 'setting_name', id_val: 'Shift_Notes',
            data: { setting_value: 'FULL WALKTHROUGH NOTE' },
            userContext: { ...MANAGER, token },
        });
        run.ok('Update shift notes');
    } catch (e) {
        run.bad('Update shift notes', e);
    }

    // ── Legacy CS order ─────────────────────────────────────────────────────
    const legacyId = uid('ORD-LEG');
    cleanup.orders.push(legacyId);
    try {
        await json('POST', '/api/action', {
            table: 'special_orders', action: 'insert',
            data: { order_id: legacyId, customer: 'LEG FULL', item: '1X LEG', contact: '', location: '2', status: 'Open', logged_by: 'CS_DESK', closed_by: '' },
            userContext: CS,
        });
        const s = await json('GET', '/api/sync');
        if (!(s.orders || []).some((o) => o.order_id === legacyId)) throw new Error('not on orders');
        run.ok('Legacy CS order on sync.orders');
    } catch (e) {
        run.bad('Legacy CS order on sync.orders', e);
    }

    // ── Betacs order workflow ───────────────────────────────────────────────
    const betacsId = uid('ORD-BT');
    cleanup.orders.push(betacsId);
    try {
        await json('POST', '/api/action', {
            table: 'special_orders', action: 'insert',
            data: {
                order_id: betacsId, customer: 'BT FULL', contact: '4035551234', needed_by: '2026-12-01',
                taken_by: 'CS DESK', route: 'Pop', item: '2X BT ITEM', location: '3', status: 'New', source: 'betacs', closed_by: '',
            },
            userContext: CS,
        });
        await json('POST', '/api/action', {
            table: 'special_orders', action: 'update', id_col: 'order_id', id_val: betacsId, data: { status: 'Ordered' }, userContext: CS,
        });
        let s = await json('GET', '/api/sync');
        if (!(s.orders_tv || []).some((o) => o.order_id === betacsId)) throw new Error('not on TV');
        await json('POST', '/api/action', {
            table: 'special_orders', action: 'update', id_col: 'order_id', id_val: betacsId, data: { status: 'Ready' }, userContext: CS,
        });
        await json('POST', '/api/action', {
            table: 'special_orders', action: 'update', id_col: 'order_id', id_val: betacsId, data: { status: 'Complete' }, userContext: CS,
        });
        run.ok('Betacs order New→Ordered→Ready→Complete');
    } catch (e) {
        run.bad('Betacs order New→Ordered→Ready→Complete', e);
    }

    // ── Markdown / expiry ───────────────────────────────────────────────────
    const killId = uid('KD');
    cleanup.kills.push(killId);
    try {
        const today = sync?.storeDate || new Date().toISOString().slice(0, 10);
        await json('POST', '/api/action', {
            table: 'kill_dates', action: 'insert',
            data: { id: killId, item: 'FULL WALKTHROUGH ITEM', item_code: 'FW-001', kill_date: today, zone: 'A5', status: 'Active' },
            userContext: { ...MANAGER, token },
        });
        run.ok('Insert kill date');
    } catch (e) {
        run.bad('Insert kill date', e);
    }

    try {
        const pngB64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
        const scan = await json('POST', '/api/markdown/import-scan', {
            filename: 'walkthrough.png', contentBase64: pngB64,
        }, token);
        if (!Array.isArray(scan.candidates)) throw new Error('no candidates array');
        run.ok('Markdown OCR import-scan', `${scan.candidates.length} candidates`);
    } catch (e) {
        run.bad('Markdown OCR import-scan', e);
    }

    try {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Sheet1');
        ws.addRow(['Item', 'Vendor Code', 'Expiration Date', 'Aisle']);
        ws.addRow(['Walkthrough Item', '1234567890', '2026-12-01', '5']);
        const b64 = Buffer.from(await wb.xlsx.writeBuffer()).toString('base64');
        const preview = await json('POST', '/api/markdown/import-excel', {
            filename: 'walkthrough.xlsx', contentBase64: b64, dry_run: true,
        }, token);
        if (!preview.dry_run || preview.import_count < 1) throw new Error('dry_run failed');
        run.ok('Markdown Excel dry-run import');
    } catch (e) {
        run.bad('Markdown Excel dry-run import', e);
    }

    // ── Receiving ───────────────────────────────────────────────────────────
    const expId = uid('E');
    cleanup.expected.push(expId);
    try {
        await json('POST', '/api/action', {
            table: 'expected_orders', action: 'insert',
            data: { exp_id: expId, vendor: 'Walkthrough Vendor', expected_day: sync?.storeWeekday || 'Monday', status: 'Pending', logged_by: MANAGER.name, category: 'general' },
            userContext: { ...MANAGER, token },
        });
        await json('POST', '/api/action', {
            table: 'expected_orders', action: 'receiving_mark_arrived', id_col: 'exp_id', id_val: expId,
            data: { create_task: '0' }, userContext: { ...MANAGER, token },
        });
        await json('POST', '/api/action', {
            table: 'expected_orders', action: 'receiving_mark_departed', id_col: 'exp_id', id_val: expId,
            data: {}, userContext: { ...MANAGER, token },
        });
        run.ok('Receiving time-in / time-out');
    } catch (e) {
        run.bad('Receiving time-in / time-out', e);
    }

    try {
        await json('POST', '/api/action', {
            table: 'expected_orders', action: 'receiving_log_arrival',
            data: { vendor: 'Adhoc Walkthrough', create_task: '0', expected_day: sync?.storeDate },
            userContext: { ...MANAGER, pin: MANAGER.pin },
        });
        run.ok('Receiving ad-hoc arrival');
    } catch (e) {
        run.bad('Receiving ad-hoc arrival', e);
    }

    // ── Manager APIs ────────────────────────────────────────────────────────
    try {
        const analytics = await json('POST', '/api/analytics', {}, token);
        if (typeof analytics.total_completed !== 'number') throw new Error('bad analytics');
        run.ok('Analytics API');
    } catch (e) {
        run.bad('Analytics API', e);
    }

    try {
        await json('POST', '/api/homebase-audits', {
            audit: {
                zone_name: 'Zone 1', premium_name: 'Walkthrough Premium',
                front_edge_pass: 1, tag_integrity_pass: 1, hole_strategy_pass: 1, clearances_pass: 1,
                notes: 'Full walkthrough audit',
            },
        }, token);
        run.ok('HomeBase audit submit');
    } catch (e) {
        run.bad('HomeBase audit submit', e);
    }

    try {
        await json('POST', '/api/manager-task-times', { task_id: taskId, est_mins: 20 }, token);
        run.ok('Manager task time correction');
    } catch (e) {
        run.bad('Manager task time correction', e);
    }

    try {
        const audit = await json('GET', `/api/manager/order-audit?order_id=${encodeURIComponent(betacsId)}`, null, token);
        if (!audit.entries?.length) throw new Error('no audit entries');
        run.ok('Manager order audit trail');
    } catch (e) {
        run.bad('Manager order audit trail', e);
    }

    try {
        const reports = await json('GET', '/api/reports', null, token);
        if (!reports.meta?.reportDate) throw new Error('reports meta missing');
        for (const key of ['shift', 'customer_orders', 'deliveries', 'oos_daily_comparison', 'completed_tasks']) {
            if (reports[key] === undefined) throw new Error(`reports missing ${key}`);
        }
        run.ok('Reports API payload sections');
    } catch (e) {
        run.bad('Reports API payload sections', e);
    }

    try {
        const backups = await json('GET', '/api/backups', null, token);
        if (!Array.isArray(backups.backups)) throw new Error('backups.backups not array');
        run.ok('Backups list API');
    } catch (e) {
        run.bad('Backups list API', e);
    }

    try {
        const exp = await request('POST', '/api/export-csv', { body: {}, token });
        if (!exp.ok) throw new Error(`HTTP ${exp.status}`);
        if (!String(exp.text).includes(',')) throw new Error('not csv');
        run.ok('Export CSV');
    } catch (e) {
        run.bad('Export CSV', e);
    }

    try {
        await json('POST', '/api/daily-rhythm', { token }, token);
        run.ok('Daily rhythm trigger');
    } catch (e) {
        run.bad('Daily rhythm trigger', e);
    }

    try {
        await json('POST', '/api/clear-ticker', {}, token);
        run.ok('Clear ticker (maintenance)');
    } catch (e) {
        run.bad('Clear ticker (maintenance)', e);
    }

    try {
        const routes = await json('GET', '/api/betacs/routes');
        if (!routes.routes?.length) throw new Error('no routes');
        run.ok('Betacs routes API');
    } catch (e) {
        run.bad('Betacs routes API', e);
    }

    // ── Cleanup ─────────────────────────────────────────────────────────────
    for (const id of cleanup.tasks) {
        try {
            await json('POST', '/api/action', {
                table: 'tasks', action: 'update', id_col: 'task_id', id_val: id, data: { status: 'Closed' },
                userContext: { ...MANAGER, token },
            });
        } catch { /* ignore */ }
    }
    for (const id of cleanup.oos) {
        try {
            await json('POST', '/api/action', {
                table: 'oos', action: 'update', id_col: 'oos_id', id_val: id, data: { status: 'Closed' },
                userContext: { ...MANAGER, token },
            });
        } catch { /* ignore */ }
    }
    for (const id of cleanup.kills) {
        try {
            await json('POST', '/api/action', {
                table: 'kill_dates', action: 'update', id_col: 'id', id_val: id, data: { status: 'Closed' },
                userContext: { ...MANAGER, token },
            });
        } catch { /* ignore */ }
    }
    for (const id of cleanup.orders) {
        try {
            await json('POST', '/api/action', {
                table: 'special_orders', action: 'update', id_col: 'order_id', id_val: id,
                data: { status: 'Closed' }, userContext: CS,
            });
        } catch { /* ignore */ }
    }
    run.ok('Cleanup test artifacts');

    return exit();
}

function exit() {
    const failed = run.summarize();
    process.exit(failed ? 1 : 0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
