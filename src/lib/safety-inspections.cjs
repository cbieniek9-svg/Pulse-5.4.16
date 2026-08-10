'use strict';

const { MONTHLY_COMMITTEE_TEMPLATE } = require('./safety-inspection-template.cjs');

const VALID_ANSWERS = new Set(['yes', 'no', 'na']);
const ISSUE_NOTE_SECTIONS = new Set(['interior', 'exterior']);

function escapeHtml(v) {
    return String(v ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function newRunId() {
    return `SI-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function ensureSafetyInspectionSchema(db) {
    db.exec(`
        CREATE TABLE IF NOT EXISTS safety_checklist_templates (
            template_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            version INTEGER NOT NULL DEFAULT 1,
            active INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS safety_checklist_sections (
            section_id TEXT PRIMARY KEY,
            template_id TEXT NOT NULL,
            section_key TEXT NOT NULL,
            title TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS safety_checklist_items (
            item_id TEXT PRIMARY KEY,
            section_id TEXT NOT NULL,
            item_no INTEGER NOT NULL,
            prompt TEXT NOT NULL,
            sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS safety_inspection_runs (
            run_id TEXT PRIMARY KEY,
            template_id TEXT NOT NULL,
            inspection_date TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'draft',
            interior_issue_note TEXT,
            exterior_issue_note TEXT,
            created_at TEXT NOT NULL,
            created_by TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            updated_by TEXT NOT NULL,
            submitted_at TEXT,
            submitted_by TEXT
        );
        CREATE TABLE IF NOT EXISTS safety_inspection_answers (
            run_id TEXT NOT NULL,
            item_id TEXT NOT NULL,
            answer TEXT,
            note TEXT,
            PRIMARY KEY (run_id, item_id)
        );
        CREATE TABLE IF NOT EXISTS safety_inspection_signatures (
            sig_id TEXT PRIMARY KEY,
            run_id TEXT NOT NULL,
            role_type TEXT NOT NULL,
            slot_num INTEGER NOT NULL,
            print_name TEXT,
            signed_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_safety_runs_date ON safety_inspection_runs(inspection_date DESC);
        CREATE INDEX IF NOT EXISTS idx_safety_runs_status ON safety_inspection_runs(status, inspection_date DESC);
        CREATE INDEX IF NOT EXISTS idx_safety_answers_run ON safety_inspection_answers(run_id);
    `);
}

function seedMonthlyCommitteeTemplate(db, serverTime = new Date().toISOString()) {
    ensureSafetyInspectionSchema(db);
    const tpl = MONTHLY_COMMITTEE_TEMPLATE;
    const existing = db.get('SELECT template_id FROM safety_checklist_templates WHERE template_id = ?', tpl.template_id);
    if (existing) return tpl.template_id;

    db.transaction(() => {
        db.run(
            `INSERT INTO safety_checklist_templates (template_id, title, version, active, created_at)
             VALUES (?,?,?,?,?)`,
            tpl.template_id, tpl.title, 1, 1, serverTime,
        );
        tpl.sections.forEach((section, sIdx) => {
            const sectionId = `${tpl.template_id}_${section.section_key}`;
            db.run(
                `INSERT INTO safety_checklist_sections (section_id, template_id, section_key, title, sort_order)
                 VALUES (?,?,?,?,?)`,
                sectionId, tpl.template_id, section.section_key, section.title, sIdx,
            );
            section.items.forEach((item, iIdx) => {
                const itemId = `${sectionId}_${item.item_no}`;
                db.run(
                    `INSERT INTO safety_checklist_items (item_id, section_id, item_no, prompt, sort_order)
                     VALUES (?,?,?,?,?)`,
                    itemId, sectionId, item.item_no, item.prompt, iIdx,
                );
            });
        });
    })();
    return tpl.template_id;
}

function getActiveTemplate(db) {
    ensureSafetyInspectionSchema(db);
    const row = db.get(
        `SELECT * FROM safety_checklist_templates WHERE active = 1 ORDER BY created_at DESC LIMIT 1`,
    );
    if (!row) return null;
    const sections = db.all(
        `SELECT * FROM safety_checklist_sections WHERE template_id = ? ORDER BY sort_order ASC, section_key ASC`,
        row.template_id,
    ) || [];
    return {
        ...row,
        sections: sections.map((section) => ({
            ...section,
            items: db.all(
                `SELECT * FROM safety_checklist_items WHERE section_id = ? ORDER BY sort_order ASC, item_no ASC`,
                section.section_id,
            ) || [],
        })),
    };
}

function loadRunRow(db, runId) {
    return db.get('SELECT * FROM safety_inspection_runs WHERE run_id = ?', runId);
}

function loadRunAnswers(db, runId) {
    const rows = db.all('SELECT item_id, answer, note FROM safety_inspection_answers WHERE run_id = ?', runId) || [];
    const map = {};
    for (const row of rows) map[row.item_id] = { answer: row.answer, note: row.note };
    return map;
}

function loadRunSignatures(db, runId) {
    return db.all(
        `SELECT * FROM safety_inspection_signatures WHERE run_id = ? ORDER BY role_type ASC, slot_num ASC`,
        runId,
    ) || [];
}

function buildRunPayload(db, runId) {
    const run = loadRunRow(db, runId);
    if (!run) return null;
    const template = getActiveTemplate(db);
    if (!template || template.template_id !== run.template_id) {
        const tplRow = db.get('SELECT * FROM safety_checklist_templates WHERE template_id = ?', run.template_id);
        if (!tplRow) return null;
    }
    const tpl = template?.template_id === run.template_id
        ? template
        : loadTemplateById(db, run.template_id);
    if (!tpl) return null;

    const answers = loadRunAnswers(db, runId);
    const signatures = loadRunSignatures(db, runId);
    let noCount = 0;
    let answeredCount = 0;
    const sections = tpl.sections.map((section) => {
        const items = section.items.map((item) => {
            const ans = answers[item.item_id] || {};
            const answer = ans.answer || null;
            if (answer) answeredCount += 1;
            if (answer === 'no') noCount += 1;
            return { ...item, answer, note: ans.note || '' };
        });
        return { ...section, items };
    });

    return {
        run,
        template: { template_id: tpl.template_id, title: tpl.title, version: tpl.version },
        sections,
        signatures,
        stats: {
            item_count: sections.reduce((n, s) => n + s.items.length, 0),
            answered_count: answeredCount,
            no_count: noCount,
        },
    };
}

function loadTemplateById(db, templateId) {
    const row = db.get('SELECT * FROM safety_checklist_templates WHERE template_id = ?', templateId);
    if (!row) return null;
    const sections = db.all(
        `SELECT * FROM safety_checklist_sections WHERE template_id = ? ORDER BY sort_order ASC`,
        templateId,
    ) || [];
    return {
        ...row,
        sections: sections.map((section) => ({
            ...section,
            items: db.all(
                `SELECT * FROM safety_checklist_items WHERE section_id = ? ORDER BY sort_order ASC, item_no ASC`,
                section.section_id,
            ) || [],
        })),
    };
}

function listInspectionRuns(db, opts = {}) {
    ensureSafetyInspectionSchema(db);
    const limit = Math.min(Math.max(Number(opts.limit) || 50, 1), 200);
    const status = opts.status ? String(opts.status).trim() : '';
    const params = [];
    let where = '1=1';
    if (status) {
        where += ' AND status = ?';
        params.push(status);
    }
    if (opts.fromDate) {
        where += ' AND inspection_date >= ?';
        params.push(opts.fromDate);
    }
    if (opts.toDate) {
        where += ' AND inspection_date <= ?';
        params.push(opts.toDate);
    }
    params.push(limit);
    const rows = db.all(
        `SELECT run_id, template_id, inspection_date, status, created_at, created_by,
                updated_at, updated_by, submitted_at, submitted_by
         FROM safety_inspection_runs
         WHERE ${where}
         ORDER BY inspection_date DESC, datetime(updated_at) DESC
         LIMIT ?`,
        ...params,
    ) || [];

    return rows.map((run) => {
        const stats = db.get(
            `SELECT COUNT(*) AS answered,
                    SUM(CASE WHEN answer = 'no' THEN 1 ELSE 0 END) AS no_count
             FROM safety_inspection_answers WHERE run_id = ? AND answer IS NOT NULL AND answer != ''`,
            run.run_id,
        ) || {};
        return {
            ...run,
            no_count: Number(stats.no_count) || 0,
            answered_count: Number(stats.answered) || 0,
        };
    });
}

function createInspectionRun(db, { inspectionDate, actorName, serverTime = new Date().toISOString() }) {
    ensureSafetyInspectionSchema(db);
    seedMonthlyCommitteeTemplate(db, serverTime);
    const template = getActiveTemplate(db);
    if (!template) {
        const err = new Error('Safety checklist template is not configured.');
        err.status = 500;
        throw err;
    }
    const day = String(inspectionDate || serverTime.slice(0, 10)).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
        const err = new Error('Inspection date must be YYYY-MM-DD.');
        err.status = 400;
        throw err;
    }
    const runId = newRunId();
    db.run(
        `INSERT INTO safety_inspection_runs (
            run_id, template_id, inspection_date, status,
            created_at, created_by, updated_at, updated_by
         ) VALUES (?,?,?,?,?,?,?,?)`,
        runId, template.template_id, day, 'draft',
        serverTime, actorName, serverTime, actorName,
    );
    return buildRunPayload(db, runId);
}

function normalizeAnswer(value) {
    if (value == null || value === '') return null;
    const v = String(value).trim().toLowerCase();
    if (v === 'y' || v === 'yes') return 'yes';
    if (v === 'n' || v === 'no') return 'no';
    if (v === 'na' || v === 'n/a') return 'na';
    return VALID_ANSWERS.has(v) ? v : null;
}

function upsertAnswer(db, runId, itemId, answer, note) {
    const normalized = normalizeAnswer(answer);
    if (answer != null && answer !== '' && !normalized) {
        const err = new Error(`Invalid answer for item ${itemId}. Use yes, no, or na.`);
        err.status = 400;
        throw err;
    }
    const existing = db.get(
        'SELECT 1 FROM safety_inspection_answers WHERE run_id = ? AND item_id = ?',
        runId, itemId,
    );
    const noteText = note != null ? String(note).slice(0, 500) : null;
    if (existing) {
        db.run(
            `UPDATE safety_inspection_answers SET answer = ?, note = ? WHERE run_id = ? AND item_id = ?`,
            normalized, noteText, runId, itemId,
        );
    } else if (normalized || noteText) {
        db.run(
            `INSERT INTO safety_inspection_answers (run_id, item_id, answer, note) VALUES (?,?,?,?)`,
            runId, itemId, normalized, noteText,
        );
    }
}

function saveInspectionRun(db, runId, patch, actorName, serverTime = new Date().toISOString()) {
    const run = loadRunRow(db, runId);
    if (!run) {
        const err = new Error('Inspection not found.');
        err.status = 404;
        throw err;
    }
    if (run.status !== 'draft') {
        const err = new Error('Submitted inspections cannot be edited.');
        err.status = 409;
        throw err;
    }

    db.transaction(() => {
        const updates = ['updated_at = ?', 'updated_by = ?'];
        const params = [serverTime, actorName];
        if (patch.inspection_date != null) {
            const day = String(patch.inspection_date).trim();
            if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
                const err = new Error('Inspection date must be YYYY-MM-DD.');
                err.status = 400;
                throw err;
            }
            updates.push('inspection_date = ?');
            params.push(day);
        }
        if (patch.interior_issue_note != null) {
            updates.push('interior_issue_note = ?');
            params.push(String(patch.interior_issue_note).slice(0, 2000));
        }
        if (patch.exterior_issue_note != null) {
            updates.push('exterior_issue_note = ?');
            params.push(String(patch.exterior_issue_note).slice(0, 2000));
        }
        params.push(runId);
        db.run(`UPDATE safety_inspection_runs SET ${updates.join(', ')} WHERE run_id = ?`, ...params);

        if (Array.isArray(patch.answers)) {
            for (const row of patch.answers) {
                if (!row?.item_id) continue;
                upsertAnswer(db, runId, row.item_id, row.answer, row.note);
            }
        }

        if (Array.isArray(patch.signatures)) {
            for (const sig of patch.signatures) {
                const roleType = String(sig.role_type || '').trim();
                const slotNum = Number(sig.slot_num);
                if (!['mgmt', 'non_mgmt'].includes(roleType) || ![1, 2].includes(slotNum)) continue;
                const printName = String(sig.print_name || '').trim().slice(0, 120);
                if (!printName) continue;
                const sigId = `${runId}_${roleType}_${slotNum}`;
                db.run(
                    `INSERT INTO safety_inspection_signatures (sig_id, run_id, role_type, slot_num, print_name, signed_at)
                     VALUES (?,?,?,?,?,?)
                     ON CONFLICT(sig_id) DO UPDATE SET
                        run_id = excluded.run_id,
                        role_type = excluded.role_type,
                        slot_num = excluded.slot_num,
                        print_name = excluded.print_name,
                        signed_at = excluded.signed_at`,
                    sigId,
                    runId,
                    roleType,
                    slotNum,
                    printName,
                    sig.signed_at || serverTime,
                );
            }
        }
    })();

    return buildRunPayload(db, runId);
}

function submitInspectionRun(db, runId, actorName, serverTime = new Date().toISOString()) {
    const payload = buildRunPayload(db, runId);
    if (!payload) {
        const err = new Error('Inspection not found.');
        err.status = 404;
        throw err;
    }
    if (payload.run.status !== 'draft') {
        const err = new Error('Inspection already submitted.');
        err.status = 409;
        throw err;
    }
    const missing = [];
    for (const section of payload.sections) {
        for (const item of section.items) {
            if (!item.answer) missing.push(item.item_no);
        }
    }
    if (missing.length) {
        const err = new Error(`Complete all checklist items before submit (${missing.length} unanswered).`);
        err.status = 400;
        throw err;
    }

    db.run(
        `UPDATE safety_inspection_runs
         SET status = 'submitted', submitted_at = ?, submitted_by = ?, updated_at = ?, updated_by = ?
         WHERE run_id = ?`,
        serverTime, actorName, serverTime, actorName, runId,
    );
    return buildRunPayload(db, runId);
}

function listInspectionRunsForReports(db, reportStart, reportEnd) {
    return listInspectionRuns(db, { fromDate: reportStart, toDate: reportEnd, status: 'submitted', limit: 120 })
        .map((run) => ({
            run_id: run.run_id,
            inspection_date: run.inspection_date,
            submitted_at: run.submitted_at,
            submitted_by: run.submitted_by,
            no_count: run.no_count,
            answered_count: run.answered_count,
        }));
}

function markCell(answer, target) {
    const a = normalizeAnswer(answer);
    return a === target ? 'X' : '';
}

function renderSectionPrintTable(section, issueNote) {
    const header = `<tr><th style="width:36px">#</th><th>${escapeHtml(section.title)} checklist item</th>
        <th style="width:36px">N/A</th><th style="width:36px">Y</th><th style="width:36px">N</th><th>Notes</th></tr>`;
    const rows = section.items.map((item) => `<tr>
        <td>${item.item_no}</td>
        <td>${escapeHtml(item.prompt)}</td>
        <td class="mark">${markCell(item.answer, 'na')}</td>
        <td class="mark">${markCell(item.answer, 'yes')}</td>
        <td class="mark">${markCell(item.answer, 'no')}</td>
        <td style="font-size:10px;white-space:pre-wrap">${escapeHtml(item.note || '')}</td>
    </tr>`).join('');
    const issueBlock = ISSUE_NOTE_SECTIONS.has(section.section_key)
        ? `<p class="issue-label">${escapeHtml(section.title)} — section notes</p>
           <div class="issue-box">${escapeHtml(issueNote || 'None at this time')}</div>`
        : '';
    return `<h2>${escapeHtml(section.title)}</h2>
        <table class="checklist">${header}${rows}</table>${issueBlock}`;
}

function signatureBlock(title, signatures) {
    const slots = [1, 2].map((slot) => {
        const sig = signatures.find((s) => s.slot_num === slot) || {};
        return `<div class="sig-slot">
            <div class="sig-line">Name (Print): ${escapeHtml(sig.print_name || '')}</div>
            <div class="sig-line sig-sign">Signature: _________________________________</div>
        </div>`;
    }).join('');
    return `<div class="sig-col"><h3>${escapeHtml(title)}</h3>${slots}</div>`;
}

function renderInspectionPrintHtml(payload, storeDisplayName) {
    const { run, template, sections, signatures } = payload;
    const mgmt = signatures.filter((s) => s.role_type === 'mgmt');
    const nonMgmt = signatures.filter((s) => s.role_type === 'non_mgmt');
    const sectionHtml = sections.map((section) => {
        const note = section.section_key === 'interior'
            ? run.interior_issue_note
            : section.section_key === 'exterior'
                ? run.exterior_issue_note
                : '';
        return renderSectionPrintTable(section, note);
    }).join('');

    const title = template.title || 'Safety Committee Monthly Inspection';
    return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
  body{font-family:Arial,sans-serif;margin:20px;color:#111;font-size:11px}
  h1{font-size:16px;margin:0 0 4px;text-transform:uppercase}
  h2{font-size:13px;margin:18px 0 6px;text-transform:uppercase;border-bottom:1px solid #999;padding-bottom:2px}
  h3{font-size:11px;margin:0 0 8px;text-transform:uppercase}
  .meta{margin-bottom:14px;color:#333}
  table.checklist{width:100%;border-collapse:collapse;margin-bottom:8px}
  table.checklist th,table.checklist td{border:1px solid #333;padding:4px 6px;vertical-align:top}
  table.checklist th{background:#eee;font-size:10px}
  table.checklist td.mark{text-align:center;font-weight:bold;width:36px}
  .issue-label{margin:8px 0 4px;font-weight:bold}
  .issue-box{border:1px solid #333;min-height:48px;padding:6px;margin-bottom:8px;white-space:pre-wrap}
  .sig-grid{display:flex;gap:24px;margin-top:20px}
  .sig-col{flex:1}
  .sig-slot{margin-bottom:14px}
  .sig-line{border-bottom:1px solid #333;min-height:18px;padding:2px 0;margin-bottom:6px}
  .sig-sign{margin-top:10px}
  .footer{margin-top:16px;font-size:10px;color:#555}
  @media print{body{margin:10mm} button{display:none}}
</style></head><body>
  <h1>${escapeHtml(storeDisplayName || 'TGP Store')} — ${escapeHtml(title)}</h1>
  <div class="meta">
    <div><strong>Date of inspection:</strong> ${escapeHtml(run.inspection_date || '')}</div>
    <div><strong>Submitted by:</strong> ${escapeHtml(run.submitted_by || run.updated_by || '')}
      ${run.submitted_at ? ` · ${escapeHtml(new Date(run.submitted_at).toLocaleString())}` : ''}</div>
  </div>
  ${sectionHtml}
  <div class="sig-grid">
    ${signatureBlock('Management committee member(s)', mgmt)}
    ${signatureBlock('Non-management committee member(s)', nonMgmt)}
  </div>
  <p class="footer">Digital record · run ${escapeHtml(run.run_id)} · generated ${new Date().toLocaleString()}</p>
  <script>window.onload=function(){window.print();};</script>
</body></html>`;
}

module.exports = {
    VALID_ANSWERS,
    ensureSafetyInspectionSchema,
    seedMonthlyCommitteeTemplate,
    getActiveTemplate,
    loadTemplateById,
    listInspectionRuns,
    listInspectionRunsForReports,
    buildRunPayload,
    createInspectionRun,
    saveInspectionRun,
    submitInspectionRun,
    renderInspectionPrintHtml,
    normalizeAnswer,
};
