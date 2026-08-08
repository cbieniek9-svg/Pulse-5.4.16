'use strict';

async function phaseFloorActions(ctx) {
    const { report, action, uid, json, token } = ctx;
    const phase = 'floor';
    const created = { tasks: [], oos: [], ticker: [] };

    await report.check(phase, 'task-insert', async () => {
        const id = uid('CM-TASK');
        await action({
            table: 'tasks', action: 'insert',
            data: {
                task_id: id, task_detail: 'chaos monkey task', status: 'Open',
                priority: 'Routine', zone: 'A1', assigned_to: 'Unassigned', est_mins: 5,
            },
        });
        created.tasks.push(id);
    });

    await report.check(phase, 'oos-insert', async () => {
        const id = uid('CM-OOS');
        await action({
            table: 'oos', action: 'insert',
            data: { oos_id: id, zone: 'A1', hole_count: 2, status: 'Open' },
        });
        created.oos.push(id);
    });

    await report.check(phase, 'ticker-insert', async () => {
        const id = uid('CM-TIK');
        await action({
            table: 'ticker', action: 'insert',
            data: { msg_id: id, message: 'chaos monkey ticker' },
        });
        created.ticker.push(id);
    });

    await report.check(phase, 'labor-update', async () => {
        await action({
            table: 'counts', action: 'update', id_col: 'id', id_val: 1,
            data: { grocery: 10, frozen: 5, hardware: 2, staff: 2 },
        });
    });

    await report.check(phase, 'shift-notes', async () => {
        await action({
            table: 'settings', action: 'update', id_col: 'setting_name', id_val: 'Shift_Notes',
            data: { setting_value: 'chaos monkey note' },
        });
    });

    await report.check(phase, 'malformed-action-rejected', async () => {
        const r = await ctx.request('POST', '/api/action', {
            token,
            body: { table: 'tasks', action: 'insert', data: null, token },
        });
        if (r.status < 400) throw new Error(`expected 4xx, got ${r.status}`);
    });

    await report.check(phase, 'sql-injection-stored-safely', async () => {
        const id = uid('CM-SQL');
        await action({
            table: 'tasks', action: 'insert',
            data: {
                task_id: id,
                task_detail: "'; DROP TABLE tasks; --",
                status: 'Open', priority: 'Routine', zone: 'A1',
                assigned_to: 'Unassigned', est_mins: 1,
            },
        });
        created.tasks.push(id);
        const sync = await json('GET', '/api/sync', null, token);
        if (!(sync.tasks || []).some((t) => t.task_id === id)) throw new Error('injected task missing');
    });

    // Soft cleanup (best-effort; destructive phase may wipe later)
    for (const id of created.tasks) {
        try {
            await action({ table: 'tasks', action: 'update', id_col: 'task_id', id_val: id, data: { status: 'Closed' } });
        } catch (_) { /* ignore */ }
    }
    for (const id of created.oos) {
        try {
            await action({ table: 'oos', action: 'update', id_col: 'oos_id', id_val: id, data: { status: 'Closed' } });
        } catch (_) { /* ignore */ }
    }

    ctx._floorCreated = created;
}

async function phaseCsBetacs(ctx) {
    const { report, action, uid, json, token, CS, request } = ctx;
    const phase = 'cs';

    await report.check(phase, 'cs-config', async () => {
        const r = await request('GET', '/api/cs/config');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
    });

    await report.check(phase, 'enable-cs-full-for-crawl', async () => {
        await action({
            table: 'settings', action: 'update', id_col: 'setting_name', id_val: 'Cs_Full_Enabled',
            data: { setting_value: '1' },
        });
        await action({
            table: 'settings', action: 'update', id_col: 'setting_name', id_val: 'Cs_Hub_Enabled',
            data: { setting_value: '1' },
        });
        await action({
            table: 'settings', action: 'update', id_col: 'setting_name', id_val: 'Betacs_Enabled',
            data: { setting_value: '1' },
        });
    });

    await report.check(phase, 'cs-login-staff', async () => {
        const r = await request('GET', '/api/cs/login-staff');
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.data?.error || ''}`);
    });

    await report.check(phase, 'legacy-desk-order', async () => {
        const id = uid('CM-LEG');
        await action({
            table: 'special_orders', action: 'insert',
            data: {
                order_id: id, customer: 'CHAOS LEGACY', item: '1X TEST', contact: '',
                location: '2', status: 'Open', logged_by: 'CS_DESK', closed_by: '',
            },
            userContext: CS,
        });
        const sync = await json('GET', '/api/sync', null, token);
        if (!(sync.orders || []).some((o) => o.order_id === id)) throw new Error('legacy order missing from sync');
    });

    // Session-gated betacs routes without session should 401
    await report.check(phase, 'betacs-orders-require-session', async () => {
        const r = await request('GET', '/api/betacs/orders');
        if (r.status !== 401 && r.status !== 403) throw new Error(`expected 401/403, got ${r.status}`);
    });

    await report.check(phase, 'due-orders-with-session', async () => {
        const r = await request('GET', '/api/cs/due-orders', { token });
        if (![200, 403, 404].includes(r.status)) throw new Error(`unexpected ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'betacs-orders-authed', async () => {
        const r = await request('GET', '/api/betacs/orders', { token });
        if (![200, 403].includes(r.status)) throw new Error(`unexpected ${r.status}`);
        return String(r.status);
    });
}

module.exports = { phaseFloorActions, phaseCsBetacs };
