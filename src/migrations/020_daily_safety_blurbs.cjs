'use strict';

const {
    ensureSafetySchema,
    seedDefaultSafetyBlurbs,
} = require('../lib/safety-blurbs.cjs');

module.exports = {
    name: 'daily_safety_blurbs',
    up(db) {
        ensureSafetySchema(db);
        seedDefaultSafetyBlurbs(db);
    },
};
