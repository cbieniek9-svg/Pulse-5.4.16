'use strict';

const {
    ensureSafetyInspectionSchema,
    seedMonthlyCommitteeTemplate,
} = require('../lib/safety-inspections.cjs');

module.exports = {
    name: 'safety_inspections',
    up(db) {
        ensureSafetyInspectionSchema(db);
        seedMonthlyCommitteeTemplate(db);
    },
};
