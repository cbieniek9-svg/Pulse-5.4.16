'use strict';

/**
 * Whether the Electron shell may open a BrowserWindow after attach-or-serve.
 * Failed restart_required / port-conflict paths must return openUi:false so
 * whenReady does not create a window after app.quit().
 *
 * @param {{ startedServer?: boolean, uiOnlyMode?: boolean, openUi?: boolean }} [result]
 * @returns {boolean}
 */
function shouldOpenDesktopUi({ startedServer = false, uiOnlyMode = false, openUi } = {}) {
    if (typeof openUi === 'boolean') return openUi;
    return !!(startedServer || uiOnlyMode);
}

module.exports = {
    shouldOpenDesktopUi,
};
