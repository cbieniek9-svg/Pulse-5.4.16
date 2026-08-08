'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * Electron 20+ defaults sandbox:true for the renderer. Sandboxed preload may only
 * require a small Electron whitelist — relative requires like ./src/app-version.cjs
 * fail with "module not found". Main passes the version via additionalArguments.
 */
function readAppVersionFromArgv() {
    const prefix = '--tgp-app-version=';
    const arg = (process.argv || []).find((a) => typeof a === 'string' && a.startsWith(prefix));
    return arg ? arg.slice(prefix.length) : '';
}

contextBridge.exposeInMainWorld('__TGP_BUILD__', {
    appVersion: readAppVersionFromArgv(),
});

contextBridge.exposeInMainWorld('localDB', {
    // New listener so React knows when the phone changed the database
    onForceRefresh: (callback) => ipcRenderer.on('force-refresh', callback),
});
