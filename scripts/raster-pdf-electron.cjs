'use strict';

/** Rasterize a PDF via Electron (Chromium PDF viewer) page screenshots. */
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

async function main() {
    const electron = require('electron');
    // When run under electron.exe this has app; when run under node, electron is a path string.
    if (typeof electron === 'string') {
        const { spawnSync } = require('child_process');
        const r = spawnSync(electron, [__filename, ...process.argv.slice(2)], { stdio: 'inherit' });
        process.exit(r.status || 0);
    }
    const { app, BrowserWindow } = electron;
    await app.whenReady();
    const pdfPath = process.argv[2] || path.join(__dirname, '..', '_calib', 'verify-filled.pdf');
    const outDir = process.argv[3] || path.join(__dirname, '..', '_calib');
    if (!fs.existsSync(pdfPath)) {
        console.error('missing pdf', pdfPath);
        app.exit(1);
        return;
    }

    // Build filled PDF first if needed via child - assume exists.
    const win = new BrowserWindow({
        width: 920,
        height: 1180,
        show: false,
        webPreferences: { offscreen: true },
    });
    const url = pathToFileURL(pdfPath).href;
    await win.loadURL(url);
    await new Promise((r) => setTimeout(r, 1500));

    // Chromium PDF viewer: try page-down through pages and screenshot
    for (let i = 0; i < 5; i += 1) {
        const img = await win.webContents.capturePage();
        const out = path.join(outDir, `electron-page-${i}.png`);
        fs.writeFileSync(out, img.toPNG());
        console.log('wrote', out, img.getSize());
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'PageDown' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'PageDown' });
        await new Promise((r) => setTimeout(r, 600));
    }
    await win.close();
    app.exit(0);
}

main().catch((err) => {
    console.error(err);
    process.exit(1);
});
