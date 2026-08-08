'use strict';

const { registerReceivingDockRoutes, TGP_STORAGE_CONFIRM_PROMPT } = require('./receiving-dock.cjs');
const { registerReceivingReportRoutes } = require('./receiving-report.cjs');

/**
 * Receiving routes registrar (dock ops + Financial Log report APIs).
 * @param {import('express').Application} server
 * @param {object} ctx
 */
function registerReceivingRoutes(server, ctx) {
    registerReceivingDockRoutes(server, ctx);
    registerReceivingReportRoutes(server, ctx);
}

module.exports = { registerReceivingRoutes, TGP_STORAGE_CONFIRM_PROMPT };
