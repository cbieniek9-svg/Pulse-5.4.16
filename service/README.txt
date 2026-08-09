# TGP Command Center — Windows service (headless)

Starts the API at boot **before anyone logs in**, so phones, TV, and `/rec` keep working after a reboot.

**Current app version:** 5.4.16 · Docs: `../docs/INDEX.md`

## Find it in Windows

- `services.msc` → **TGP Command Center** (service id `TGP-CommandCenter`)
- Or: `sc query TGP-CommandCenter` → STATE should be **RUNNING**
- Or: browser `http://127.0.0.1:3001/api/ready` → `"ok": true`

## Why you might not see the service

The service is **not** installed just by deploying the app. You must run the installer once and **approve the UAC / Administrator prompt**.

Until that succeeds, `services.msc` will not list **TGP Command Center**, and `sc query TGP-CommandCenter` returns error 1060.

## ABI — always 145

The service runs **`electron.exe` with `ELECTRON_RUN_AS_NODE=1`**, so `better-sqlite3` stays on **NODE_MODULE_VERSION 145** — same as the desktop `.exe`.

- `npm install` / `prepare:store` → `rebuild:electron` (145)
- **Do not** run `npm run rebuild:node` on a live store — that builds ABI 137 and the service will crash until you restore 145.

## Install (do this once)

1. Close the desktop TGP `.exe` if it is running (frees port 3001).
2. Double-click **`INSTALL.cmd`** in this folder  
   (or right-click `Install-TGP-Service.ps1` → Run with PowerShell).
3. Click **Yes** on the Administrator / UAC prompt.
4. Wait for **`=== SERVICE OK ===`**.
5. Open `services.msc` and find **TGP Command Center** (Running).

The installer **always rewrites** `TGP-CommandCenter.xml` with absolute paths for this PC
(from `TGP-CommandCenter.xml.template`). After copying `resources/app` to another machine,
run install again — do not reuse another PC's XML.

If it fails, open **`install.log`** in this folder and `logs\` for WinSW output.

## Quick checks

```
sc query TGP-CommandCenter
curl http://127.0.0.1:3001/api/ready
```

Expect `"ok": true` and a VERSION on mobile login.

## Uninstall

Admin: `tgp-service-uninstall.cmd`

## Layout

| Path | Role |
|------|------|
| `INSTALL.cmd` | Double-click installer (elevates) |
| `Install-TGP-Service.ps1` | Real installer + `install.log` |
| `TGP-CommandCenter.xml` | WinSW config (rewritten with absolute paths on install) |
| `TGP-CommandCenter.exe` | WinSW wrapper (included by `prepare:store`; store install should not need internet) |
| `../node_modules/electron/dist/electron.exe` | Service runtime (Electron-as-Node, ABI 145) |
| `../runtime/node/` | Optional portable Node for rebuild tooling only |
| `../server.cjs` | Headless API entry |

## Reboot smoke

See `REBOOT_SMOKE.txt`.
