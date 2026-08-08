'use strict';

/**
 * Simulates ~1 year of multi-user store operations against a live Command Center.
 * Set TGP_SIM_DAYS=30 for a quick smoke of the simulation logic.
 */
const {
    BASE, waitForServer, json, request, WalkthroughRunner,
} = require('./helpers/api-client.cjs');
const { authenticatePersonas, userContext, createRng, PERSONAS } = require('./helpers/sim-users.cjs');
const { ORDER_ROUTES } = require('../src/lib/special-orders.cjs');

const run = new WalkthroughRunner();
const DAYS = Math.max(1, parseInt(process.env.TGP_SIM_DAYS || '365', 10));
const ZONES = ['A1', 'A5', 'Receiving', 'Zone 1', 'Zone 4'];
const PRIORITIES = ['High', 'Urgent', 'Medium'];

const stats = {
    days: DAYS,
    tasksOpened: 0,
    tasksClosed: 0,
    oosOpened: 0,
    ordersLegacy: 0,
    ordersBetacs: 0,
    receivingEvents: 0,
    homebaseAudits: 0,
    dailyRhythms: 0,
    eodSweeps: 0,
    tickerPosts: 0,
};

async function postAction(token, persona, payload) {
    return json('POST', '/api/action', {
        ...payload,
        userContext: userContext(persona),
    }, token);
}

async function main() {
    console.log(`\n=== TGP YEAR SIMULATION (${DAYS} days, multi-user) ===\n`);
    console.log(`Target: ${BASE}\n`);

    let users;
    let managerToken;
    const rng = createRng(20260519);

    try {
        await waitForServer();
        run.ok('Server reachable');
    } catch (e) {
        run.bad('Server reachable', e);
        return exit(1);
    }

    try {
        users = await authenticatePersonas();
        managerToken = users.manager.token;
        run.ok('Multi-user auth', `${Object.keys(users).filter((k) => k !== 'cs').length} staff + CS desk`);
    } catch (e) {
        run.bad('Multi-user auth', e);
        return exit(1);
    }

    try {
        await json('POST', '/api/clear-db', {}, managerToken);
        run.ok('Fresh DB for simulation (clear-db)');
    } catch (e) {
        run.bad('Fresh DB for simulation (clear-db)', e);
    }

    try {
        await postAction(managerToken, users.manager, {
            table: 'settings', action: 'update', id_col: 'setting_name', id_val: 'Betacs_Enabled',
            data: { setting_value: '1' },
        });
        run.ok('Betacs enabled for simulation');
    } catch (e) {
        run.bad('Betacs enabled for simulation', e);
    }

    const runTag = Date.now().toString(36).toUpperCase();
    const t0 = Date.now();
    let lastProgress = 0;

    for (let day = 0; day < DAYS; day++) {
        const clerk = day % 2 === 0 ? users.clerkA : users.manager;
        const zone = ZONES[day % ZONES.length];
        const dayTag = String(day).padStart(3, '0');

        // ── Floor: tasks (manager — clerks cannot create tasks without shift lead) ──
        const taskId = `SIM-${runTag}-T-${dayTag}`;
        try {
            await postAction(managerToken, users.manager, {
                table: 'tasks', action: 'insert',
                data: {
                    task_id: taskId,
                    task_detail: `SIM DAY ${day} zone ${zone}`,
                    status: 'Open',
                    priority: PRIORITIES[day % PRIORITIES.length],
                    zone,
                    assigned_to: clerk.name,
                    est_mins: 10 + (day % 20),
                },
            });
            stats.tasksOpened++;
            await postAction(managerToken, users.manager, {
                table: 'tasks', action: 'update', id_col: 'task_id', id_val: taskId,
                data: { status: 'Closed' },
            });
            stats.tasksClosed++;
        } catch (e) {
            run.bad(`Day ${day} task cycle`, e);
        }

        // ── OOS (~60% of days) ───────────────────────────────────────────────
        if (rng() > 0.4) {
            try {
                const oosId = `SIM-${runTag}-O-${dayTag}`;
                await postAction(clerk.token, clerk, {
                    table: 'oos', action: 'insert',
                    data: { oos_id: oosId, zone, hole_count: 1 + (day % 5), status: 'Open' },
                });
                stats.oosOpened++;
                await postAction(clerk.token, clerk, {
                    table: 'oos', action: 'update', id_col: 'oos_id', id_val: oosId,
                    data: { status: 'Closed' },
                });
            } catch (e) {
                run.bad(`Day ${day} OOS`, e);
            }
        }

        // ── CS orders (legacy + betacs alternating) ──────────────────────────
        if (day % 2 === 0) {
            try {
                const orderId = `SIM-${runTag}-LEG-${dayTag}`;
                await postAction(null, users.cs, {
                    table: 'special_orders', action: 'insert',
                    data: {
                        order_id: orderId, customer: `SIM CUST ${day}`, item: '1X SIM ITEM',
                        contact: '', location: String(1 + (day % 22)), status: 'Open',
                        logged_by: PERSONAS.cs.name, closed_by: '',
                    },
                });
                stats.ordersLegacy++;
                await postAction(null, users.cs, {
                    table: 'special_orders', action: 'update', id_col: 'order_id', id_val: orderId,
                    data: { status: 'Closed' },
                });
            } catch (e) {
                run.bad(`Day ${day} legacy order`, e);
            }
        } else {
            try {
                const orderId = `SIM-${runTag}-BT-${dayTag}`;
                await postAction(null, users.cs, {
                    table: 'special_orders', action: 'insert',
                    data: {
                        order_id: orderId, customer: `SIM BT ${day}`, contact: '4035550100',
                        needed_by: '2026-12-01', taken_by: 'CS DESK', route: ORDER_ROUTES[day % ORDER_ROUTES.length],
                        item: '2X SIM BT', location: String(1 + (day % 22)), status: 'New',
                        source: 'betacs', closed_by: '',
                    },
                });
                await postAction(null, users.cs, {
                    table: 'special_orders', action: 'update', id_col: 'order_id', id_val: orderId,
                    data: { status: 'Ordered' },
                });
                await postAction(null, users.cs, {
                    table: 'special_orders', action: 'update', id_col: 'order_id', id_val: orderId,
                    data: { status: 'Ready' },
                });
                await postAction(null, users.cs, {
                    table: 'special_orders', action: 'update', id_col: 'order_id', id_val: orderId,
                    data: { status: 'Complete' },
                });
                stats.ordersBetacs++;
            } catch (e) {
                run.bad(`Day ${day} betacs order`, e);
            }
        }

        // ── Receiving (~every 5 days) ──────────────────────────────────────
        if (day % 5 === 0) {
            try {
                await postAction(managerToken, users.manager, {
                    table: 'expected_orders', action: 'receiving_log_arrival',
                    data: { vendor: `SIM Vendor ${day}`, create_task: '0' },
                });
                stats.receivingEvents++;
            } catch (e) {
                run.bad(`Day ${day} receiving`, e);
            }
        }

        // ── Ticker (~every 10 days) ────────────────────────────────────────
        if (day % 10 === 0) {
            try {
                await postAction(managerToken, users.manager, {
                    table: 'ticker', action: 'insert',
                    data: { msg_id: `SIM-M-${dayTag}`, message: `SIM TICKER DAY ${day}` },
                });
                stats.tickerPosts++;
            } catch (e) {
                run.bad(`Day ${day} ticker`, e);
            }
        }

        // ── HomeBase audit (~monthly) ────────────────────────────────────────
        if (day % 30 === 0) {
            try {
                await json('POST', '/api/homebase-audits', {
                    audit: {
                        zone_name: zone,
                        premium_name: `Premium ${day}`,
                        front_edge_pass: 1,
                        tag_integrity_pass: 1,
                        hole_strategy_pass: 1,
                        clearances_pass: 1,
                        notes: `Simulation audit day ${day}`,
                    },
                }, managerToken);
                stats.homebaseAudits++;
            } catch (e) {
                run.bad(`Day ${day} homebase audit`, e);
            }
        }

        // ── Daily rhythm (manager, once per day) ───────────────────────────
        try {
            await json('POST', '/api/daily-rhythm', { token: managerToken }, managerToken);
            stats.dailyRhythms++;
        } catch { /* already loaded today is OK */ }

        // ── Monthly EOD sweep (~12/year; server always vacuums on sweep) ─────
        if (day > 0 && day % 30 === 0) {
            try {
                await json('POST', '/api/eod-sweep', {}, managerToken);
                stats.eodSweeps++;
            } catch (e) {
                run.bad(`Day ${day} EOD sweep`, e);
            }
        }

        const pct = Math.floor(((day + 1) / DAYS) * 100);
        if (pct >= lastProgress + 10) {
            lastProgress = pct;
            process.stdout.write(`  … ${pct}% (day ${day + 1}/${DAYS})\n`);
        }
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    run.ok('Simulation loop complete', `${elapsed}s`);

    // ── Post-simulation validation ──────────────────────────────────────────
    try {
        const sync = await json('GET', '/api/sync', null, managerToken);
        if (!sync.features?.betacs) throw new Error('betacs feature off');
        if (!Array.isArray(sync.staff) || sync.staff.length < 2) throw new Error('staff degraded');
        run.ok('Post-sim sync integrity', `${sync.staff.length} staff`);
    } catch (e) {
        run.bad('Post-sim sync integrity', e);
    }

    try {
        const reports = await json('GET', '/api/reports', null, managerToken);
        if (!reports.meta?.reportDate) throw new Error('reports broken');
        run.ok('Post-sim reports API', reports.meta.reportDate);
    } catch (e) {
        run.bad('Post-sim reports API', e);
    }

    try {
        const analytics = await json('POST', '/api/analytics', {}, managerToken);
        if (typeof analytics.total_completed !== 'number') throw new Error('analytics broken');
        run.ok('Post-sim analytics', `${analytics.total_completed} completed tasks`);
    } catch (e) {
        run.bad('Post-sim analytics', e);
    }

    console.log('\n--- Simulation stats ---');
    Object.entries(stats).forEach(([k, v]) => console.log(`  ${k}: ${v}`));
    console.log('');

    return exit(run.summarize('YEAR SIMULATION') ? 1 : 0);
}

function exit(code) {
    process.exit(code);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
