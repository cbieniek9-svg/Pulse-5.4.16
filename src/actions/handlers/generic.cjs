'use strict';

/**
 * generic action handlers for POST /api/action.
 * @param {object} deps
 */
function createGenericHandlers({ db, broadcastUpdate }) {
    return {
        generic_insert(ctx) {
            const cols = Object.keys(ctx.workingData).join(', ');
            const phs = Object.keys(ctx.workingData).map(() => '?').join(', ');
            db.run(`INSERT INTO ${ctx.table} (${cols}) VALUES (${phs})`, ...Object.values(ctx.workingData));
            broadcastUpdate({ table: ctx.table, action: 'insert', data: ctx.workingData });
        },

        generic_update(ctx) {
            const sets = Object.keys(ctx.workingData).map((k) => `${k} = ?`).join(', ');
            const result = db.run(
                `UPDATE ${ctx.table} SET ${sets} WHERE ${ctx.id_col} = ?`,
                ...Object.values(ctx.workingData),
                ctx.id_val,
            );
            if ((result?.changes ?? 0) === 0) {
                const exists = db.get(`SELECT 1 AS ok FROM ${ctx.table} WHERE ${ctx.id_col} = ?`, ctx.id_val);
                if (!exists) {
                    const err = new Error('Record not found.');
                    err.status = 404;
                    throw err;
                }
            }
            broadcastUpdate({ table: ctx.table, action: 'update', id_col: ctx.id_col, id_val: ctx.id_val, data: ctx.workingData });
        },

        generic_delete(ctx) {
            const result = db.run(`DELETE FROM ${ctx.table} WHERE ${ctx.id_col} = ?`, ctx.id_val);
            if ((result?.changes ?? 0) === 0) {
                const err = new Error('Record not found.');
                err.status = 404;
                throw err;
            }
            broadcastUpdate({ table: ctx.table, action: 'delete', id_col: ctx.id_col, id_val: ctx.id_val });
        },
    };
}

module.exports = { createGenericHandlers };
