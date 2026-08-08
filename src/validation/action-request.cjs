'use strict';

const { ACTION_SCHEMAS } = require('../constants/action-schema.cjs');

function validateAction({ table, action, data, id_col, id_val }) {
    const e = (msg, status = 400) => { const err = new Error(msg); err.status = status; throw err; };
    const schema = ACTION_SCHEMAS[table];
    if (!schema) e(`Unknown table: ${table}`);
    if (!schema.actions.includes(action)) e(`Action '${action}' is not permitted on '${table}'.`);
    if ((action === 'update' || action === 'delete') && (!schema.idCols.includes(id_col) || id_val == null))
        e('Missing or invalid record ID.');
    if (action === 'insert' || action === 'update') {
        if (!data || typeof data !== 'object' || Array.isArray(data)) e('Action data must be an object.');
        const keys = Object.keys(data);
        if (action === 'insert' && keys.length === 0) e('Insert data cannot be empty.');
        const bad = keys.filter((k) => !schema.columns.includes(k));
        if (bad.length) e(`Invalid field(s): ${bad.join(', ')}`);
    }
}

module.exports = { validateAction };
