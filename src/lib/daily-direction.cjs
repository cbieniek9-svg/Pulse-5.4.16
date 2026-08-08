'use strict';

/**
 * Daily Direction domain facade.
 * Implementations live under ./daily-direction/*.cjs — keep this export surface stable.
 */

const helpers = require('./daily-direction/helpers.cjs');
const orderDay = require('./daily-direction/order-day.cjs');
const risks = require('./daily-direction/risks.cjs');
const mustWins = require('./daily-direction/must-wins.cjs');
const amendments = require('./daily-direction/amendments.cjs');
const views = require('./daily-direction/views.cjs');
const mutations = require('./daily-direction/mutations.cjs');

module.exports = {
    WALK_NOTE_FLAGS: helpers.WALK_NOTE_FLAGS,
    STATUS_COLORS: helpers.STATUS_COLORS,
    deriveDayStatus: helpers.deriveDayStatus,
    isTgpVendorName: helpers.isTgpVendorName,
    resolveDirectionOrderDay: orderDay.resolveDirectionOrderDay,
    repairPostedDailyDirectionOrderDay: orderDay.repairPostedDailyDirectionOrderDay,
    collectSystemRisks: risks.collectSystemRisks,
    suggestMustWins: mustWins.suggestMustWins,
    syncMustWinsWithOpenBoard: mustWins.syncMustWinsWithOpenBoard,
    reconcileMustWinsFromBoard: mustWins.reconcileMustWinsFromBoard,
    buildDefaultFloorMessage: mustWins.buildDefaultFloorMessage,
    buildAmendmentTriggers: amendments.buildAmendmentTriggers,
    buildAmendmentSuggestion: amendments.buildAmendmentSuggestion,
    buildDefaultShiftUpdateMessage: amendments.buildDefaultShiftUpdateMessage,
    fingerprintTriggers: amendments.fingerprintTriggers,
    buildCheckpointSuggestion: amendments.buildCheckpointSuggestion,
    buildDailyDirectionDraft: views.buildDailyDirectionDraft,
    buildDailyDirectionFloorView: views.buildDailyDirectionFloorView,
    loadDailyDirectionFloor: views.loadDailyDirectionFloor,
    loadDailyDirectionReportView: views.loadDailyDirectionReportView,
    loadShiftUpdates: views.loadShiftUpdates,
    saveDailyDirectionEdits: mutations.saveDailyDirectionEdits,
    approveDailyDirection: mutations.approveDailyDirection,
    dismissDailyDirectionCheckpoint: mutations.dismissDailyDirectionCheckpoint,
    ignoreAmendmentSuggestion: mutations.ignoreAmendmentSuggestion,
    dismissAmendmentSuggestion: mutations.dismissAmendmentSuggestion,
    saveShiftUpdateDraft: mutations.saveShiftUpdateDraft,
    postShiftUpdate: mutations.postShiftUpdate,
    updatePostedDailyDirection: mutations.updatePostedDailyDirection,
    loadDailyDirectionRow: helpers.loadDailyDirectionRow,
    normalizeDailyDirectionFloorMessage: helpers.normalizeDailyDirectionFloorMessage,
    normalizeStatusOverride: helpers.normalizeStatusOverride,
};
