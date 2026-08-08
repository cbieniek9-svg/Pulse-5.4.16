'use strict';

const {
    ensureVendorAliasSchema,
    seedDefaultVendorAliases,
    normalizeExistingReceivingVendors,
} = require('../lib/vendor-canonical.cjs');

module.exports = {
    name: 'receiving_vendor_cleanup',
    up(db) {
        ensureVendorAliasSchema(db);
        seedDefaultVendorAliases(db);
        normalizeExistingReceivingVendors(db);
    },
};
