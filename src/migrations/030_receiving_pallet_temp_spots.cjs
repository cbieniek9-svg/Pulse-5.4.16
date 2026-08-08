'use strict';

module.exports = {
    name: 'receiving_pallet_temp_spots',
    up(db) {
        const cols = db.all('PRAGMA table_info(receiving_pallets)').map((c) => c.name);
        if (!cols.includes('temp_spot_1')) {
            db.exec('ALTER TABLE receiving_pallets ADD COLUMN temp_spot_1 REAL');
        }
        if (!cols.includes('temp_spot_2')) {
            db.exec('ALTER TABLE receiving_pallets ADD COLUMN temp_spot_2 REAL');
        }
        if (!cols.includes('temp_spot_3')) {
            db.exec('ALTER TABLE receiving_pallets ADD COLUMN temp_spot_3 REAL');
        }
    },
};
