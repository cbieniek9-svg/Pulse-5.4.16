'use strict';

async function phaseSafeReports(ctx) {
    const { report, request, token, json } = ctx;
    const phase = 'safe-reports';

    await report.check(phase, 'safe-login-options', async () => {
        const r = await request('GET', '/api/safe/login-options', { token });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'safety-template', async () => {
        const r = await request('GET', '/api/safety/template', { token });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'safety-inspections-list', async () => {
        const r = await request('GET', '/api/safety/inspections', { token });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'investigations-list', async () => {
        const r = await request('GET', '/api/safety/investigations', { token });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'reports-payload', async () => {
        const r = await request('GET', '/api/reports', { token });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${r.data?.error || ''}`);
    });

    await report.check(phase, 'health-authed', async () => {
        const r = await request('GET', '/api/health', { token });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
    });

    await report.check(phase, 'maintenance-health', async () => {
        const r = await request('GET', '/api/maintenance/health', { token });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'backups-list', async () => {
        const r = await request('GET', '/api/backups', { token });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'daily-direction-get', async () => {
        const r = await request('GET', '/api/daily-direction', { token });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'rhythm-status', async () => {
        const r = await request('GET', '/api/rhythm/status', { token });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'presence-board', async () => {
        const r = await request('GET', '/api/presence/board', { token });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'homebase-audit-valid', async () => {
        const r = await request('POST', '/api/homebase-audits', {
            token,
            body: {
                token,
                audit: {
                    zone_name: 'A1',
                    premium_name: 'CHAOS PREMIUM',
                    front_edge_pass: 1,
                    tag_integrity_pass: 1,
                },
            },
        });
        if (r.status >= 500) throw new Error(`HTTP ${r.status}: ${JSON.stringify(r.data)}`);
        return String(r.status);
    });

    await report.check(phase, 'homebase-audit-rejects-junk', async () => {
        const r = await request('POST', '/api/homebase-audits', {
            token,
            body: { token, audit: { zone_name: 'A1' } },
        });
        if (r.status < 400 || r.status >= 500) throw new Error(`expected 4xx, got ${r.status}`);
    });

    await report.check(phase, 'oversized-ticker-handled', async () => {
        const big = 'X'.repeat(512 * 1024);
        const r = await request('POST', '/api/action', {
            token,
            body: {
                table: 'ticker', action: 'insert',
                data: { msg_id: `CM-BIG-${Date.now()}`, message: big },
                token,
                userContext: { token },
            },
        });
        if (r.status >= 500) throw new Error(`server 5xx on oversized: ${r.status}`);
        return String(r.status);
    });
}

async function phaseSettingsMaint(ctx) {
    const { report, request, token, action } = ctx;
    const phase = 'settings-maint';

    await report.check(phase, 'staff-shifts-health', async () => {
        const r = await request('GET', '/api/staff-shifts/health', { token });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'manager-audit-log', async () => {
        const r = await request('GET', '/api/manager/audit-log', { token });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'order-audit', async () => {
        const r = await request('GET', '/api/manager/order-audit', { token });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'settings-batch-empty', async () => {
        const r = await request('POST', '/api/settings-batch', {
            token,
            body: { token, settings: {} },
        });
        if (r.status >= 500) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'daily-rhythm-post', async () => {
        const r = await request('POST', '/api/daily-rhythm', {
            token,
            body: { token },
        });
        if (r.status >= 500) throw new Error(`HTTP ${r.status}: ${r.data?.error || ''}`);
        return String(r.status);
    });

    await report.check(phase, 'backup-db', async () => {
        const r = await request('POST', '/api/backup-db', { token, body: { token } });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    await report.check(phase, 'export-csv', async () => {
        const r = await request('POST', '/api/export-csv', { token, body: { token } });
        if (![200, 403].includes(r.status)) throw new Error(`HTTP ${r.status}`);
        return String(r.status);
    });

    // Soft setting write that should be reversible
    await report.check(phase, 'settings-write-training-flag', async () => {
        await action({
            table: 'settings', action: 'update',
            id_col: 'setting_name', id_val: 'Training_Mode_Enabled',
            data: { setting_value: '1' },
        });
    });
}

module.exports = { phaseSafeReports, phaseSettingsMaint };
