'use strict';

const { isTrainingStaff } = require('../../lib/training-staff.cjs');
const { insertStaffRow, staffHasColumn } = require('../../lib/staff-permissions.cjs');

function safeStaffPayload(data) {
    return Object.fromEntries(
        Object.entries(data || {}).filter(([key]) => !['pin', 'pin_hashed'].includes(key)),
    );
}

/**
 * staff action handlers for POST /api/action.
 * @param {object} deps
 */
function createStaffHandlers({ db, broadcastUpdate, getStoreDateStamp, actionHandlers }) {
    return {
        staff_update(ctx) {
            const row = db.get('SELECT name FROM staff WHERE id = ?', ctx.id_val);
            if (
                (row && isTrainingStaff(row.name))
                || isTrainingStaff(ctx.workingData?.name)
            ) {
                const err = new Error('This revoked legacy account cannot be modified.');
                err.status = 403;
                throw err;
            }
            const dbData = { ...ctx.workingData };
            if (dbData.pin && typeof dbData.pin === 'string' && dbData.pin.length > 0) {
                const bcrypt = require('bcryptjs');
                if (!/^\$2[aby]\$\d\d\$/.test(dbData.pin)) {
                    dbData.pin = bcrypt.hashSync(dbData.pin, 10);
                }
                dbData.pin_hashed = 1;
            }
            if (staffHasColumn(db, 'shift_lead_eligible')) {
                if (dbData.role === 'Store Manager') {
                    dbData.shift_lead_eligible = 0;
                } else if (dbData.role && dbData.role !== 'Store Manager') {
                    dbData.shift_lead_eligible = 1;
                }
            } else {
                delete dbData.shift_lead_eligible;
            }
            const sets = Object.keys(dbData).map((key) => `${key} = ?`).join(', ');
            const result = db.run(
                `UPDATE staff SET ${sets} WHERE id = ?`,
                ...Object.values(dbData),
                ctx.id_val,
            );
            if ((result?.changes ?? 0) === 0) {
                const error = new Error('Record not found.');
                error.status = 404;
                error.code = 'RECORD_NOT_FOUND';
                throw error;
            }
            broadcastUpdate({
                table: 'staff',
                action: 'update',
                id_col: 'id',
                id_val: ctx.id_val,
                data: safeStaffPayload(dbData),
            });
        },

        staff_insert(ctx) {
            if (isTrainingStaff(ctx.workingData.name)) {
                const err = new Error('This revoked legacy account name is reserved.');
                err.status = 403;
                throw err;
            }
            const dbData = { ...ctx.workingData };
            const role = String(dbData.role || 'Clerk').trim();
            dbData.role = role;
            if (dbData.permissions == null || dbData.permissions === '') {
                const { defaultPermissionsForRole } = require('../../lib/staff-permissions.cjs');
                dbData.permissions = defaultPermissionsForRole(role, dbData.app_access);
            }
            const inserted = insertStaffRow(db, dbData);
            broadcastUpdate({
                table: ctx.table,
                action: 'insert',
                data: safeStaffPayload(inserted),
            });
        },

        staff_delete(ctx) {
            const row = db.get('SELECT name FROM staff WHERE id = ?', ctx.id_val);
            if (row && isTrainingStaff(row.name)) {
                const err = new Error('The training profile cannot be deleted.');
                err.status = 403;
                throw err;
            }
            db.run('DELETE FROM staff WHERE id = ?', ctx.id_val);
            broadcastUpdate({ table: 'staff', action: 'delete', id_col: 'id', id_val: ctx.id_val });
        },
    };
}

module.exports = { createStaffHandlers };
