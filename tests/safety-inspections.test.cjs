'use strict';

const { describe, it, test } = require('node:test');
const assert = require('node:assert/strict');
const {
    ensureSafetyInspectionSchema,
    seedMonthlyCommitteeTemplate,
    getActiveTemplate,
    createInspectionRun,
    saveInspectionRun,
    submitInspectionRun,
    listInspectionRunsForReports,
    renderInspectionPrintHtml,
    normalizeAnswer,
} = require('../src/lib/safety-inspections.cjs');

function makeDb() {
    const templates = [];
    const sections = [];
    const items = [];
    const runs = [];
    const answers = [];
    const signatures = [];

    const db = {
        exec(sql) { /* schema noop for tests */ },
        get(sql, ...params) {
            const q = String(sql);
            if (q.includes('FROM safety_checklist_templates WHERE template_id')) {
                return templates.find((t) => t.template_id === params[0]) || null;
            }
            if (q.includes('FROM safety_checklist_templates WHERE active')) {
                return templates.find((t) => t.active === 1) || null;
            }
            if (q.includes('FROM safety_inspection_runs WHERE run_id')) {
                return runs.find((r) => r.run_id === params[0]) || null;
            }
            if (q.includes('FROM safety_inspection_answers WHERE run_id')) {
                if (q.includes('COUNT(*)')) {
                    const rows = answers.filter((a) => a.run_id === params[0] && a.answer);
                    const noCount = rows.filter((a) => a.answer === 'no').length;
                    return { answered: rows.length, no_count: noCount };
                }
                if (q.includes('AND item_id')) {
                    return answers.find((a) => a.run_id === params[0] && a.item_id === params[1]) || null;
                }
                return null;
            }
            return null;
        },
        all(sql, ...params) {
            const q = String(sql);
            if (q.includes('FROM safety_checklist_sections')) {
                return sections.filter((s) => s.template_id === params[0]).sort((a, b) => a.sort_order - b.sort_order);
            }
            if (q.includes('FROM safety_checklist_items')) {
                return items.filter((i) => i.section_id === params[0]).sort((a, b) => a.sort_order - b.sort_order);
            }
            if (q.includes('FROM safety_inspection_signatures')) {
                return signatures.filter((s) => s.run_id === params[0]);
            }
            if (q.includes('FROM safety_inspection_answers WHERE run_id')) {
                return answers.filter((a) => a.run_id === params[0]);
            }
            if (q.includes('FROM safety_inspection_runs')) {
                let filtered = runs.slice();
                let pi = 0;
                if (q.includes('status = ?')) {
                    filtered = filtered.filter((r) => r.status === params[pi]);
                    pi += 1;
                }
                if (q.includes('inspection_date >= ?')) {
                    filtered = filtered.filter((r) => r.inspection_date >= params[pi]);
                    pi += 1;
                }
                if (q.includes('inspection_date <= ?')) {
                    filtered = filtered.filter((r) => r.inspection_date <= params[pi]);
                    pi += 1;
                }
                const limit = params[params.length - 1];
                return filtered.slice(0, limit);
            }
            return [];
        },
        run(sql, ...params) {
            const q = String(sql);
            if (q.startsWith('INSERT INTO safety_checklist_templates')) {
                templates.push({
                    template_id: params[0], title: params[1], version: params[2], active: params[3], created_at: params[4],
                });
            } else if (q.startsWith('INSERT INTO safety_checklist_sections')) {
                sections.push({
                    section_id: params[0], template_id: params[1], section_key: params[2], title: params[3], sort_order: params[4],
                });
            } else if (q.startsWith('INSERT INTO safety_checklist_items')) {
                items.push({
                    item_id: params[0], section_id: params[1], item_no: params[2], prompt: params[3], sort_order: params[4],
                });
            } else if (q.startsWith('INSERT INTO safety_inspection_runs')) {
                runs.push({
                    run_id: params[0], template_id: params[1], inspection_date: params[2], status: params[3],
                    interior_issue_note: null, exterior_issue_note: null,
                    created_at: params[4], created_by: params[5], updated_at: params[6], updated_by: params[7],
                    submitted_at: null, submitted_by: null,
                });
            } else if (q.includes('UPDATE safety_inspection_runs')) {
                const run = runs.find((r) => r.run_id === params[params.length - 1]);
                if (!run) return;
                if (q.includes("status = 'submitted'")) {
                    run.status = 'submitted';
                    run.submitted_at = params[0];
                    run.submitted_by = params[1];
                    run.updated_at = params[2];
                    run.updated_by = params[3];
                } else {
                    run.updated_at = params[0];
                    run.updated_by = params[1];
                    if (q.includes('interior_issue_note')) run.interior_issue_note = params[2];
                    if (q.includes('exterior_issue_note')) run.exterior_issue_note = params[2];
                }
            } else if (q.startsWith('INSERT INTO safety_inspection_answers')) {
                answers.push({ run_id: params[0], item_id: params[1], answer: params[2], note: params[3] });
            } else if (q.startsWith('UPDATE safety_inspection_answers')) {
                const row = answers.find((a) => a.run_id === params[2] && a.item_id === params[3]);
                if (row) { row.answer = params[0]; row.note = params[1]; }
            }
        },
        transaction(fn) {
            return fn;
        },
    };

    db._seed = () => {
        ensureSafetyInspectionSchema(db);
        seedMonthlyCommitteeTemplate(db, '2026-01-28T12:00:00.000Z');
    };
    return db;
}

test('normalizeAnswer maps y/n/na variants', () => {
    assert.equal(normalizeAnswer('Y'), 'yes');
    assert.equal(normalizeAnswer('no'), 'no');
    assert.equal(normalizeAnswer('N/A'), 'na');
});

test('seedMonthlyCommitteeTemplate loads interior exterior kitchen sections', () => {
    const db = makeDb();
    db._seed();
    const tpl = getActiveTemplate(db);
    assert.ok(tpl);
    assert.equal(tpl.sections.length, 3);
    assert.ok(tpl.sections.find((s) => s.section_key === 'interior')?.items.length >= 35);
});

test('submit requires all items answered', () => {
    const db = makeDb();
    db._seed();
    const payload = createInspectionRun(db, {
        inspectionDate: '2026-01-28',
        actorName: 'Pat',
        serverTime: '2026-01-28T15:00:00.000Z',
    });
    assert.throws(
        () => submitInspectionRun(db, payload.run.run_id, 'Pat', '2026-01-28T16:00:00.000Z'),
        /Complete all checklist items/,
    );
});

test('submitted run is locked with finding count', () => {
    const db = makeDb();
    db._seed();
    const tpl = getActiveTemplate(db);
    const payload = createInspectionRun(db, {
        inspectionDate: '2026-01-28',
        actorName: 'Pat',
        serverTime: '2026-01-28T15:00:00.000Z',
    });
    saveInspectionRun(db, payload.run.run_id, {
        answers: tpl.sections.flatMap((s) => s.items.map((item) => ({
            item_id: item.item_id,
            answer: item.item_no === 1 && s.section_key === 'interior' ? 'no' : 'yes',
        }))),
        interior_issue_note: 'Wet mat at produce',
    }, 'Pat', '2026-01-28T15:30:00.000Z');
    const submitted = submitInspectionRun(db, payload.run.run_id, 'Pat', '2026-01-28T16:00:00.000Z');
    assert.equal(submitted.run.status, 'submitted');
    assert.equal(submitted.stats.no_count, 1);
    assert.match(submitted.run.interior_issue_note || '', /Wet mat/);
});

test('renderInspectionPrintHtml includes section and finding marks', () => {
    const db = makeDb();
    db._seed();
    const tpl = getActiveTemplate(db);
    const payload = createInspectionRun(db, {
        inspectionDate: '2026-01-28',
        actorName: 'Pat',
        serverTime: '2026-01-28T15:00:00.000Z',
    });
    saveInspectionRun(db, payload.run.run_id, {
        answers: tpl.sections.flatMap((s) => s.items.map((item) => ({
            item_id: item.item_id,
            answer: 'yes',
        }))),
    }, 'Pat', '2026-01-28T15:30:00.000Z');
    submitInspectionRun(db, payload.run.run_id, 'Pat', '2026-01-28T16:00:00.000Z');
    const full = require('../src/lib/safety-inspections.cjs').buildRunPayload(db, payload.run.run_id);
    const html = renderInspectionPrintHtml(full, 'Test Store');
    assert.match(html, /Interior/);
    assert.match(html, /Management committee member/);
    assert.match(html, /Date of inspection/);
});
