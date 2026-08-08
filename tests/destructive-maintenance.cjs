'use strict';

/**
 * Validates destructive maintenance endpoints (clear-db, eod-sweep, etc.).
 * Run only against training / test Command Center instances.
 */
const {
    waitForServer, json, request, managerToken, uid, WalkthroughRunner,
} = require('./helpers/api-client.cjs');
const { authenticatePersonas, userContext } = require('./helpers/sim-users.cjs');

const run = new WalkthroughRunner();

async function postAction(token, persona, payload) {
    return json('POST', '/api/action', {
        ...payload,
        userContext: userContext(persona),
    }, token);
}

async function main() {
    console.log('\n=== TGP DESTRUCTIVE MAINTENANCE TESTS ===\n');
    console.log('WARNING: clears operational data. Staff + settings preserved.\n');

    let token;
    let users;

    try {
        await waitForServer();
        run.ok('Server reachable');
    } catch (e) {
        run.bad('Server reachable', e);
        return exit(1);
    }

    try {
        users = await authenticatePersonas();
        token = users.manager.token;
        run.ok('Manager session');
    } catch (e) {
        run.bad('Manager session', e);
        return exit(1);
    }

    // Seed rows so destructive ops have something to act on
    const taskId = uid('DEST-T');
    const killId = uid('DEST-K');
    try {
        await postAction(token, users.manager, {
            table: 'tasks', action: 'insert',
            data: {
                task_id: taskId, task_detail: 'DESTRUCTIVE TEST TASK', status: 'Open',
                priority: 'High', zone: 'A5', assigned_to: 'Unassigned', est_mins: 5,
            },
        });
        await postAction(token, users.manager, {
            table: 'ticker', action: 'insert',
            data: { msg_id: uid('DEST-M'), message: 'DESTRUCTIVE TICKER' },
        });
        const sync = await json('GET', '/api/sync', null, token);
        const today = sync.storeDate || new Date().toISOString().slice(0, 10);
        await postAction(token, users.manager, {
            table: 'kill_dates', action: 'insert',
            data: {
                id: killId, item: 'DEST ITEM', item_code: 'D-1', kill_date: today,
                zone: 'A5', status: 'Active',
            },
        });
        run.ok('Seed data for destructive tests');
    } catch (e) {
        run.bad('Seed data for destructive tests', e);
    }

    try {
        await json('POST', '/api/clear-ticker', {}, token);
        const sync = await json('GET', '/api/sync');
        if ((sync.ticker || []).length) throw new Error('ticker not cleared');
        run.ok('clear-ticker');
    } catch (e) {
        run.bad('clear-ticker', e);
    }

    try {
        const r = await json('POST', '/api/clear-markdown-db', {}, token);
        if (r.success !== true) throw new Error('clear-markdown-db failed');
        run.ok('clear-markdown-db', JSON.stringify(r).slice(0, 80));
    } catch (e) {
        run.bad('clear-markdown-db', e);
    }

    try {
        await json('POST', '/api/eod-sweep', { vacuum: false }, token);
        run.ok('eod-sweep (no vacuum)');
    } catch (e) {
        run.bad('eod-sweep (no vacuum)', e);
    }

    try {
        const exp = await request('POST', '/api/export-csv', { body: {}, token });
        if (!exp.ok && exp.status !== 404) throw new Error(`export HTTP ${exp.status}`);
        run.ok('export-csv', exp.ok ? 'csv returned' : 'no rows (OK after sweep)');
    } catch (e) {
        run.bad('export-csv', e);
    }

    try {
        const bak = await request('POST', '/api/backup-db', { body: {}, token, raw: true });
        if (bak.status !== 200) throw new Error(`backup HTTP ${bak.status}`);
        if (!bak.headers.get('content-disposition')?.includes('TGP_Backup')) {
            throw new Error('missing backup disposition header');
        }
        run.ok('backup-db download');
    } catch (e) {
        run.bad('backup-db download', e);
    }

    try {
        const denied = await request('POST', '/api/clear-db', { body: {} });
        if (denied.status !== 403) throw new Error(`clear-db should require auth, got ${denied.status}`);
        run.ok('clear-db blocked without auth');
    } catch (e) {
        run.bad('clear-db blocked without auth', e);
    }

    try {
        await json('POST', '/api/clear-db', {}, token);
        const sync = await json('GET', '/api/sync', null, token);
        if ((sync.tasks || []).length) throw new Error('tasks remain after clear-db');
        if ((sync.oos || []).length) throw new Error('oos remain after clear-db');
        if ((sync.orders || []).length) throw new Error('orders remain after clear-db');
        if (!sync.staff?.length) throw new Error('staff wiped — should be preserved');
        run.ok('clear-db (operational tables empty, staff intact)');
    } catch (e) {
        run.bad('clear-db (operational tables empty, staff intact)', e);
    }

    try {
        await json('POST', '/api/eod-sweep', { vacuum: true }, token);
        run.ok('eod-sweep post clear-db (vacuum)');
    } catch (e) {
        run.bad('eod-sweep post clear-db (vacuum)', e);
    }

    return exit(run.summarize('DESTRUCTIVE MAINTENANCE') ? 1 : 0);
}

function exit(code) {
    process.exit(code);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
