'use strict';

/** Role/aisle placeholders — stores customize via Settings → FIFO assignments. */
const DEFAULT_FIFO_AISLE_ASSIGNMENTS = [
    { staff: 'Clerk 1', aisles: ['Tills', 'A6'] },
    { staff: 'Clerk 2', aisles: ['Tills', 'A5'] },
    { staff: 'Clerk 3', aisles: ['A3'] },
    { staff: 'Clerk 4', aisles: ['A2'] },
    { staff: 'Clerk 5', aisles: ['A1'] },
    { staff: 'Bakery', aisles: ['Bakery'] },
    { staff: 'Clerk 6', aisles: ['A6'] },
    { staff: 'Clerk 7', aisles: ['A2'] },
    { staff: 'Clerk 8', aisles: ['A3'] },
    { staff: 'Clerk 9', aisles: ['A4'] },
    { staff: 'Clerk 10', aisles: ['A5'] },
    { staff: 'Clerk 11', aisles: ['A4'] },
];

const EVERYDAY_RHYTHM_TASKS = [
    { detail: 'FIFO Audit', priority: 'Routine', zone: 'General' },
    { detail: 'Level off displays', priority: 'Routine', zone: 'General' },
    { detail: 'Check freezer for fallen items', priority: 'Routine', zone: 'General' },
    { detail: 'Store walk', priority: 'Routine', zone: 'General' },
    { detail: 'Mid-day zone walk (Core 4)', priority: 'Routine', zone: 'General' },
    { detail: 'Pre-close zone walk (Core 4)', priority: 'Routine', zone: 'General' },
    { detail: 'Daily direction huddle', priority: 'Routine', zone: 'General' },
];

function ensureEverydayRhythmTasks(db) {
    EVERYDAY_RHYTHM_TASKS.forEach((t, i) => {
        const exists = db.get("SELECT 1 FROM rhythm_tasks WHERE day='Everyday' AND detail=?", t.detail);
        if (!exists) {
            db.run(
                'INSERT INTO rhythm_tasks (id, day, detail, priority, zone, est_mins) VALUES (?, ?, ?, ?, ?, ?)',
                `R-ED-ENSURE-${i}`, 'Everyday', t.detail, t.priority, t.zone, 15,
            );
        }
    });
}

const DEFAULT_ZONE_SECTION_LABELS = {
    'map-a1': { label: 'A1', sublabel: 'POP' },
    'map-a2': { label: 'A2', sublabel: 'SNACK' },
    'map-a3': { label: 'A3', sublabel: 'HBA' },
    'map-a4': { label: 'A4', sublabel: 'BAKE' },
    'map-a5': {
        label: 'A5',
        sublabel: 'COFFEE',
        sections: [
            { label: 'Coffee', owner: '' },
            { label: 'Monin/Torani', owner: '' },
            { label: 'Wraps', owner: '' },
        ],
    },
    'map-a6': { label: 'A6', sublabel: 'ETH/PET' },
    'map-a7': { label: 'A7', sublabel: 'FS PAPER' },
    'map-a8': { label: 'A8', sublabel: 'PKGS' },
    'map-rfz': { label: 'RFZ', sublabel: 'RETAIL FRZ' },
    'map-fsfrz': { label: 'FS FRZ', sublabel: 'MEAT' },
};

function renameCommandInJson(jsonText) {
    if (!jsonText || !jsonText.includes('COMMAND')) return jsonText;
    return jsonText
        .replace(/"COMMAND"/g, '"Zone 4"')
        .replace(/:\s*"COMMAND"/g, ': "Zone 4"');
}

/**
 * One-time style migration: COMMAND → Zone 4 in zone settings JSON blobs.
 * @param {object} db
 */
function migrateCommandToZone4(db) {
    const keys = ['Zone_Mapping', 'Zone_Ownership', 'Zone_Names'];
    keys.forEach((name) => {
        const row = db.get('SELECT setting_value FROM settings WHERE setting_name=?', name);
        if (!row?.setting_value?.includes('COMMAND')) return;
        db.run(
            'UPDATE settings SET setting_value=? WHERE setting_name=?',
            renameCommandInJson(row.setting_value),
            name,
        );
    });

    const mappingRow = db.get("SELECT setting_value FROM settings WHERE setting_name='Zone_Mapping'");
    if (mappingRow?.setting_value) {
        try {
            const mapping = JSON.parse(mappingRow.setting_value);
            if (!mapping['Zone 4']) mapping['Zone 4'] = [];
            if (!mapping['Zone 4'].includes('map-cmd')) {
                mapping['Zone 4'].push('map-cmd');
                db.run(
                    "UPDATE settings SET setting_value=? WHERE setting_name='Zone_Mapping'",
                    JSON.stringify(mapping),
                );
            }
        } catch (_) { /* ignore */ }
    }
}

function ensureStoreZoneDefaults(db) {
    migrateCommandToZone4(db);

    if (!db.get("SELECT 1 FROM settings WHERE setting_name='FIFO_Aisle_Assignments'")) {
        db.run(
            "INSERT INTO settings (setting_name, setting_value) VALUES ('FIFO_Aisle_Assignments', ?)",
            JSON.stringify(DEFAULT_FIFO_AISLE_ASSIGNMENTS),
        );
    }

    const labelsRow = db.get("SELECT setting_value FROM settings WHERE setting_name='Zone_Section_Labels'");
    if (labelsRow?.setting_value) {
        try {
            const parsed = JSON.parse(labelsRow.setting_value);
            const a5 = parsed['map-a5'];
            if (a5 && !a5.sections) {
                parsed['map-a5'] = { ...DEFAULT_ZONE_SECTION_LABELS['map-a5'], ...a5 };
                db.run(
                    "UPDATE settings SET setting_value=? WHERE setting_name='Zone_Section_Labels'",
                    JSON.stringify(parsed),
                );
            }
        } catch (_) { /* ignore */ }
    }

    db.run(
        "UPDATE rhythm_tasks SET detail='FIFO Audit' WHERE detail LIKE 'FIFO Audit (%' OR detail='FIFO Audit (pick an aisle)'",
    );

    ensureEverydayRhythmTasks(db);

    // Do not force TV_Native_Shell='1' over an intentional '0'.
}

module.exports = {
    DEFAULT_FIFO_AISLE_ASSIGNMENTS,
    DEFAULT_ZONE_SECTION_LABELS,
    EVERYDAY_RHYTHM_TASKS,
    ensureEverydayRhythmTasks,
    migrateCommandToZone4,
    ensureStoreZoneDefaults,
    renameCommandInJson,
};
