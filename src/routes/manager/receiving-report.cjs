'use strict';

const { registerReceivingReportAccessRoutes } = require('./receiving-report-access.cjs');
const { registerReceivingReportDayRoutes } = require('./receiving-report-day.cjs');
const { registerReceivingReportImportRoutes } = require('./receiving-report-import.cjs');
const { registerReceivingReportSheetRoutes } = require('./receiving-report-sheets.cjs');
const { registerReceivingReportPeriodRoutes } = require('./receiving-report-period.cjs');

/**
 * Financial Log / Edmonton receiving report HTTP routes.
 */
function registerReceivingReportRoutes(server, ctx) {
    registerReceivingReportAccessRoutes(server, ctx);
    registerReceivingReportDayRoutes(server, ctx);
    registerReceivingReportImportRoutes(server, ctx);
    registerReceivingReportSheetRoutes(server, ctx);
    registerReceivingReportPeriodRoutes(server, ctx);
}

module.exports = { registerReceivingReportRoutes };
