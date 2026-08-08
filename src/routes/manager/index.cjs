'use strict';

const { registerDeviceRoutes } = require('./devices.cjs');
const { registerOpsRoutes } = require('./ops.cjs');
const { registerMaintenanceRoutes } = require('./maintenance.cjs');
const { registerAuditRoutes } = require('./audits.cjs');
const { registerOrderAuditRoutes } = require('./order-audit.cjs');
const { registerCommsRoutes } = require('./comms.cjs');
const { registerDailyDirectionRoutes } = require('./daily-direction.cjs');
const { registerSafetyRoutes } = require('./safety.cjs');
const { registerReceivingRoutes } = require('./receiving.cjs');
const { registerSafetyInspectionRoutes } = require('./safety-inspections.cjs');
const { registerInventoryCountRoutes } = require('./inventory-count.cjs');
const { registerIncidentInvestigationRoutes } = require('./incident-investigations.cjs');

/**
 * Manager / ops routes (devices, exports, audits, maintenance).
 * @param {import('express').Application} server
 * @param {object} ctx
 */
function registerManagerRoutes(server, ctx) {
    registerDeviceRoutes(server, ctx);
    registerOpsRoutes(server, ctx);
    registerMaintenanceRoutes(server, ctx);
    registerAuditRoutes(server, ctx);
    registerOrderAuditRoutes(server, ctx);
    registerCommsRoutes(server, ctx);
    registerDailyDirectionRoutes(server, ctx);
    registerSafetyRoutes(server, ctx);
    registerReceivingRoutes(server, ctx);
    registerSafetyInspectionRoutes(server, ctx);
    registerInventoryCountRoutes(server, ctx);
    registerIncidentInvestigationRoutes(server, ctx);
}

module.exports = { registerManagerRoutes };
