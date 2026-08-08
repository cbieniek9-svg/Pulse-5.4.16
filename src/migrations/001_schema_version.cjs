'use strict';

/** Bootstrap table is created by runner; this migration records the baseline. */
module.exports = {
    name: 'schema_version_baseline',
    up(_db) {
        /* no-op — schema_version created in runner before first migration */
    },
};
