'use strict';

const { ensureIncidentInvestigationSchema } = require('../lib/incident-investigations.cjs');

module.exports = {
    name: 'incident_investigations',
    up(db) {
        ensureIncidentInvestigationSchema(db);
    },
};
