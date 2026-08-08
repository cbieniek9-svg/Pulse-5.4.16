'use strict';

const fs = require('fs');
const path = require('path');
const { DEFAULT_ZONE_SECTION_LABELS } = require('./store-zone-settings.cjs');

const TEMPLATE_ROOT = path.join(__dirname, '..', '..', 'store-templates');

function resolveTemplateDir(name = 'default') {
    const safe = String(name || 'default').replace(/[^a-zA-Z0-9_-]/g, '');
    const dir = path.join(TEMPLATE_ROOT, safe || 'default');
    if (!fs.existsSync(dir)) {
        const err = new Error(`Store template "${safe || 'default'}" not found.`);
        err.status = 404;
        throw err;
    }
    return dir;
}

function readJsonFile(filePath) {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function loadStoreTemplate(name = 'default') {
    const dir = resolveTemplateDir(name);
    return {
        name: path.basename(dir),
        vendorSchedule: readJsonFile(path.join(dir, 'vendor-schedule.json')),
        rhythmTasks: readJsonFile(path.join(dir, 'rhythm-tasks.json')),
        zoneSettings: readJsonFile(path.join(dir, 'zone-settings.json')),
    };
}

function listStoreTemplates() {
    if (!fs.existsSync(TEMPLATE_ROOT)) return [];
    return fs.readdirSync(TEMPLATE_ROOT, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
}

/**
 * Seed rhythm_tasks + vendor_schedule when tables are empty (first install).
 */
function seedRhythmFromTemplate(db, template) {
    const hasRhythm = db.get('SELECT 1 FROM rhythm_tasks LIMIT 1');
    const hasVendors = db.get('SELECT 1 FROM vendor_schedule LIMIT 1');
    if (hasRhythm && hasVendors) return { seededRhythm: false, seededVendors: false };

    const rt = template.rhythmTasks;
    const vs = template.vendorSchedule;
    let rhythmCount = 0;
    let vendorCount = 0;

    db.transaction(() => {
        if (!hasVendors && vs) {
            for (const [day, vendors] of Object.entries(vs)) {
                (vendors || []).forEach((vendor) => {
                    db.run(
                        'INSERT INTO vendor_schedule (id, day, vendor) VALUES (?, ?, ?)',
                        `V-${day}-${String(vendor).replace(/\s+/g, '')}`,
                        day,
                        vendor,
                    );
                    vendorCount += 1;
                });
            }
        }
        if (!hasRhythm && rt) {
            (rt.everyday || []).forEach((t, i) => {
                db.run(
                    'INSERT INTO rhythm_tasks (id, day, detail, priority, zone, est_mins) VALUES (?, ?, ?, ?, ?, ?)',
                    `R-ED-${i}`, 'Everyday', t.detail, t.priority, t.zone, t.est_mins || 15,
                );
                rhythmCount += 1;
            });
            (rt.tgp_order_days || []).forEach((day) => {
                const t = rt.tgp_order_task || { detail: 'TGP Order', priority: 'Urgent', zone: 'Receiving' };
                db.run(
                    'INSERT INTO rhythm_tasks (id, day, detail, priority, zone, est_mins) VALUES (?, ?, ?, ?, ?, ?)',
                    `R-${day}-TGP`, day, t.detail, t.priority, t.zone, t.est_mins || 15,
                );
                rhythmCount += 1;
            });
            (rt.non_tgp_days || []).forEach((day) => {
                (rt.non_tgp_tasks || []).forEach((t, i) => {
                    db.run(
                        'INSERT INTO rhythm_tasks (id, day, detail, priority, zone, est_mins) VALUES (?, ?, ?, ?, ?, ?)',
                        `R-${day}-${i}`, day, t.detail, t.priority, t.zone, t.est_mins || 15,
                    );
                    rhythmCount += 1;
                });
            });
        }
    })();

    return { seededRhythm: rhythmCount > 0, seededVendors: vendorCount > 0, rhythmCount, vendorCount };
}

/**
 * Apply zone defaults from template (no person names — ownership stays in settings).
 */
function applyZoneSettingsFromTemplate(db, template, { overwrite = false } = {}) {
    const zs = template.zoneSettings || {};
    const labels = zs.zone_section_labels || DEFAULT_ZONE_SECTION_LABELS;
    const upsert = (name, value) => {
        const exists = db.get('SELECT 1 FROM settings WHERE setting_name=?', name);
        if (exists && !overwrite) return false;
        db.run(
            'INSERT OR REPLACE INTO settings (setting_name, setting_value) VALUES (?, ?)',
            name,
            typeof value === 'string' ? value : JSON.stringify(value),
        );
        return true;
    };

    const applied = [];
    if (zs.zone_mapping) applied.push(upsert('Zone_Mapping', zs.zone_mapping) && 'Zone_Mapping');
    if (zs.zone_names) applied.push(upsert('Zone_Names', zs.zone_names) && 'Zone_Names');
    if (labels) applied.push(upsert('Zone_Section_Labels', labels) && 'Zone_Section_Labels');
    if (Array.isArray(zs.fifo_aisle_assignments) && zs.fifo_aisle_assignments.length) {
        applied.push(upsert('FIFO_Aisle_Assignments', zs.fifo_aisle_assignments) && 'FIFO_Aisle_Assignments');
    }
    return applied.filter(Boolean);
}

/**
 * Manager action: apply template (rhythm/vendors only when empty unless force).
 */
function applyStoreTemplate(db, templateName = 'default', { forceRhythm = false, forceZone = false } = {}) {
    const template = loadStoreTemplate(templateName);
    let rhythmResult = { seededRhythm: false, seededVendors: false };
    if (forceRhythm) {
        db.transaction(() => {
            db.run('DELETE FROM rhythm_tasks');
            db.run('DELETE FROM vendor_schedule');
        })();
        rhythmResult = seedRhythmFromTemplate(db, template);
    } else {
        rhythmResult = seedRhythmFromTemplate(db, template);
    }
    const zoneApplied = applyZoneSettingsFromTemplate(db, template, { overwrite: forceZone });
    return {
        template: template.name,
        ...rhythmResult,
        zoneSettingsApplied: zoneApplied,
    };
}

module.exports = {
    loadStoreTemplate,
    listStoreTemplates,
    seedRhythmFromTemplate,
    applyZoneSettingsFromTemplate,
    applyStoreTemplate,
};
