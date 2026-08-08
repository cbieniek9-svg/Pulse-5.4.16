'use strict';

const { ensureStoreInstanceId } = require('../lib/store-instance-id.cjs');

module.exports = {
    name: 'store_instance_id',
    up(db) {
        ensureStoreInstanceId(db);
    },
};
