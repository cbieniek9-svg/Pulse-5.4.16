'use strict';

const fs = require('fs');
const path = require('path');

let cached = null;

function templatePath() {
    return path.join(__dirname, '..', '..', 'store-templates', 'default', 'audit-walk-templates.json');
}

function loadAuditWalkTemplates() {
    if (cached) return cached;
    try {
        cached = JSON.parse(fs.readFileSync(templatePath(), 'utf8'));
    } catch (_) {
        cached = { store_walk: { sections: [] }, perishables_walk: { sections: [] }, quick_miss_checks: [] };
    }
    return cached;
}

function resetAuditWalkTemplatesCache() {
    cached = null;
}

function flattenWalkItems(walk) {
    const sections = walk?.sections || [];
    return sections
        .filter((s) => (s.items || []).length)
        .map((s) => ({
            section: s.section,
            items: s.items,
        }));
}

function getStoreWalkChecklist() {
    return flattenWalkItems(loadAuditWalkTemplates().store_walk);
}

function getPerishablesWalkChecklist() {
    return flattenWalkItems(loadAuditWalkTemplates().perishables_walk);
}

function getAuditWalkPayload() {
    const data = loadAuditWalkTemplates();
    return {
        source: data.source,
        extracted_at: data.extracted_at,
        store_walk: getStoreWalkChecklist(),
        perishables_walk: getPerishablesWalkChecklist(),
        item_counts: {
            store_walk: getStoreWalkChecklist().reduce((n, s) => n + s.items.length, 0),
            perishables_walk: getPerishablesWalkChecklist().reduce((n, s) => n + s.items.length, 0),
        },
    };
}

module.exports = {
    loadAuditWalkTemplates,
    resetAuditWalkTemplatesCache,
    getStoreWalkChecklist,
    getPerishablesWalkChecklist,
    getAuditWalkPayload,
};
