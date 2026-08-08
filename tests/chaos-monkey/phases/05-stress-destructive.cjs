'use strict';

/**
 * Bounded stress — find races/locks without cascading the server to death.
 */
async function phaseStress(ctx) {
    const { report, request, token, action, uid, readyProbe, BASE } = ctx;
    const phase = 'stress';

    await report.check(phase, 'pre-stress-ready', async () => {
        const r = await readyProbe();
        if (!r.ok) throw new Error('ready.ok false');
        return `uptime=${r.uptime}`;
    });

    await report.check(phase, 'concurrent-sync-25', async () => {
        const results = await Promise.all(
            Array.from({ length: 25 }, () =>
                fetch(`${BASE}/api/sync`, { headers: { 'x-session-token': token } })
                    .then((r) => r.ok)
                    .catch(() => false),
            ),
        );
        const ok = results.filter(Boolean).length;
        if (ok < 20) throw new Error(`only ${ok}/25 sync ok`);
        return `${ok}/25`;
    });

    await report.check(phase, 'concurrent-task-writes-10', async () => {
        const ids = [];
        const writes = await Promise.all(
            Array.from({ length: 10 }, async (_, i) => {
                const id = uid(`CM-ST-${i}`);
                try {
                    await action({
                        table: 'tasks', action: 'insert',
                        data: {
                            task_id: id, task_detail: `stress ${i}`, status: 'Open',
                            priority: 'Routine', zone: 'A1', assigned_to: 'Unassigned', est_mins: 1,
                        },
                    });
                    ids.push(id);
                    return true;
                } catch {
                    return false;
                }
            }),
        );
        const ok = writes.filter(Boolean).length;
        for (const id of ids) {
            try {
                await action({
                    table: 'tasks', action: 'update', id_col: 'task_id', id_val: id,
                    data: { status: 'Closed' },
                });
            } catch (_) { /* ignore */ }
        }
        if (ok < 7) throw new Error(`only ${ok}/10 writes ok`);
        return `${ok}/10`;
    });

    await report.check(phase, 'sse-burst-40', async () => {
        // Node 18+ has no EventSource — use stream-token + short-lived fetch abort
        let opened = 0;
        let failed = 0;
        const controllers = [];
        await Promise.all(
            Array.from({ length: 40 }, async () => {
                try {
                    const tr = await request('POST', '/api/stream-token', { token, body: { token } });
                    if (!tr.ok || !tr.data?.streamToken) {
                        failed += 1;
                        return;
                    }
                    const ac = new AbortController();
                    controllers.push(ac);
                    const res = await fetch(`${BASE}/api/stream?st=${encodeURIComponent(tr.data.streamToken)}`, {
                        signal: ac.signal,
                        headers: { Accept: 'text/event-stream' },
                    });
                    if (res.ok) opened += 1;
                    else failed += 1;
                } catch {
                    failed += 1;
                }
            }),
        );
        // Close quickly — do not leave zombies
        controllers.forEach((c) => c.abort());
        await ctx.sleep(200);
        if (opened < 25) throw new Error(`only ${opened}/40 streams opened (failed=${failed})`);
        return `opened=${opened} failed=${failed}`;
    });

    await report.check(phase, 'post-stress-ready', async () => {
        const r = await readyProbe();
        if (!r.ok) throw new Error('API not ready after stress — CASCADE');
        return `uptime=${r.uptime}`;
    });
}

async function phaseDestructive(ctx) {
    const { report, request, token, readyProbe } = ctx;
    const phase = 'destructive';

    report.meta.destructive = true;
    report.meta.destructiveWarning = 'This phase performs real clear/EOD operations on TGP_BASE_URL';

    await report.check(phase, 'clear-ticker', async () => {
        const r = await request('POST', '/api/clear-ticker', { token, body: { token } });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'clear-markdown-db', async () => {
        const r = await request('POST', '/api/clear-markdown-db', { token, body: { token } });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'eod-sweep', async () => {
        const r = await request('POST', '/api/eod-sweep', { token, body: { token } });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}: ${r.data?.error || ''}`);
        return String(r.status);
    });

    await report.check(phase, 'secure-store', async () => {
        const r = await request('POST', '/api/maintenance/secure-store', { token, body: { token } });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'clear-db', async () => {
        const r = await request('POST', '/api/clear-db', { token, body: { token } });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}: ${r.data?.error || ''}`);
        return String(r.status);
    });

    await report.check(phase, 'post-destructive-ready', async () => {
        const r = await readyProbe();
        if (!r.ok) throw new Error('API dead after destructive — CASCADE');
        return `uptime=${r.uptime}`;
    });

    await report.check(phase, 'post-clear-sync', async () => {
        const r = await request('GET', '/api/sync', { token });
        if (!r.ok) throw new Error(`sync ${r.status} after clear-db`);
        return `tasks=${(r.data.tasks || []).length}`;
    });
}

module.exports = { phaseStress, phaseDestructive };
