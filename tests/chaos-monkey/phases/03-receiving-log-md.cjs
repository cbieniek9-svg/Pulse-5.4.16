'use strict';

async function phaseReceiving(ctx) {
    const { report, action, uid, request, token, json } = ctx;
    const phase = 'receiving';

    await report.check(phase, 'pallet-departments', async () => {
        const r = await request('GET', '/api/receiving/pallet-departments', { token });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
    });

    await report.check(phase, 'store-transfers-config', async () => {
        const r = await request('GET', '/api/receiving/store-transfers/config', { token });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
    });

    await report.check(phase, 'store-transfers-list', async () => {
        const r = await request('GET', '/api/receiving/store-transfers', { token });
        if (r.status === 403) return '403 gated';
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.data?.error || ''}`);
        return String(r.status);
    });

    await report.check(phase, 'expected-order-cycle', async () => {
        const id = uid('CM-EXP');
        await action({
            table: 'expected_orders', action: 'insert',
            data: {
                exp_id: id, vendor: 'CHAOS VENDOR', category: 'general',
                expected_day: 'Monday', status: 'Pending', logged_by: 'CHAOS FIXTURE',
            },
        });
        await action({
            table: 'expected_orders', action: 'receiving_mark_arrived',
            id_col: 'exp_id', id_val: id, data: { create_task: '0' },
        });
        await action({
            table: 'expected_orders', action: 'receiving_mark_departed',
            id_col: 'exp_id', id_val: id, data: {},
        });
    });
}

async function phaseFinancialLog(ctx) {
    const { report, request, token } = ctx;
    const phase = 'financial';

    const gets = [
        '/api/receiving/report/access',
        '/api/receiving/report/period-status',
        '/api/receiving/report/period',
        '/api/receiving/report',
        '/api/receiving/report/total-report',
        '/api/receiving/report/shrink',
        '/api/receiving/report/sales',
        '/api/receiving/report/receiving-totals',
        '/api/receiving/report/margin',
        '/api/receiving/report/vendors',
        '/api/receiving/report/dock-reconciliation',
        '/api/receiving/report/count-cycle',
    ];

    for (const path of gets) {
        await report.check(phase, `get:${path}`, async () => {
            const r = await request('GET', path, { token });
            // Feature may be shadow-gated → 403 is a soft finding if unexpected for managers
            if (r.status === 403) return '403 gated';
            if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.data?.error || ''}`);
            return String(r.status);
        });
    }

    await report.check(phase, 'put-day-noop-shape', async () => {
        const r = await request('PUT', '/api/receiving/report/day', {
            token,
            body: { token, date: '2099-01-01' },
        });
        // 400/403/404 acceptable; 500 is a finding
        if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });
}

async function phaseMarkdownCount(ctx) {
    const { report, action, uid, request, token, settings } = ctx;
    const phase = 'markdown-count';

    await report.check(phase, 'kill-date-insert', async () => {
        await action({
            table: 'kill_dates', action: 'insert',
            data: {
                item: 'CHAOS KILL', zone: 'Dairy', kill_date: '2099-12-31',
                quantity: 1, logged_by: 'CHAOS FIXTURE', status: 'Open',
            },
        });
    });

    await report.check(phase, 'markdown-import-scan-empty', async () => {
        const r = await request('POST', '/api/markdown/import-scan', {
            token,
            body: { token, text: '' },
        });
        if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'inventory-config', async () => {
        const r = await request('GET', '/api/inventory/config', { token });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.data?.enabled ? 'enabled' : 'disabled';
    });

    const invEnabled = settings.Inventory_Count_Enabled === '1';
    if (invEnabled) {
        await report.check(phase, 'inventory-sessions', async () => {
            const r = await request('GET', '/api/inventory/sessions', { token });
            if (!r.ok) throw new Error(`HTTP ${r.status}`);
        });
    } else {
        report.skip(phase, 'inventory-sessions', 'Inventory_Count_Enabled off');
        await report.check(phase, 'inventory-blocked-when-off', async () => {
            const r = await request('POST', '/api/inventory/sessions', {
                token,
                body: { token, location: 'A1' },
            });
            if (r.status !== 403) throw new Error(`expected 403, got ${r.status}`);
        });
    }
}

module.exports = { phaseReceiving, phaseFinancialLog, phaseMarkdownCount };
