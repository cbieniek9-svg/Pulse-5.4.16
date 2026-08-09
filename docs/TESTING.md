# Testing — Chaos, Hell 3000, Lighthouse

**App:** TGP Command Center / Pulse **5.4.16**  
**Updated:** 2026-08-08

## Layers

| Layer | Command | Role |
|-------|---------|------|
| **Gate** | `npm run test:ci` / `test:gate` | Fast CI: syntax + core auth/rhythm/inventory/receiving units |
| **Deep unit** | `npm run test:unit` | Full `tests/*.test.cjs` under Electron |
| **Smoke UI** | `npm run test:smoke` | Playwright SPA happy paths (shared `tests/helpers/playwright-auth.js`) |
| **Chaos** | `npm run test:chaos-monkey` | Preferred stress lane (throwaway DB only) |
| **Classic chaos** | `node tests/run-chaos-monkey.cjs` | SSE / DB hammer / time-warp (legacy twin; keep one lane long-term) |

Playwright staff fixtures: one reader — `readPlaywrightStaffCache` / `managerCredentials` in `tests/helpers/playwright-auth.js`.

## Golden rules

1. **Never point destructive chaos at the live store DB** (`:3001` production data). Use a throwaway `TGP_DATA_DIR` + port (e.g. `:3102`).
2. **Hell 3000 unit tests must not inherit `TGP_PORT` / `TGP_DATA_DIR`.** Those env vars collide with `ui-shell.test.cjs` (`startAppServer`) and can hang for hours on “Port already in use” + rhythm watchdog ticks. `tests/chaos-hell-3000.cjs` strips them from child env.
3. After `npm run build:ui`, restart the API/service under test or expect `restart_required` banners.

## Commands

| Command | What it does |
|---------|----------------|
| `npm run test:gate` / `test:ci` | Syntax + gate unit filters (auth, rhythm, inventory, receiving core) |
| `npm run test:unit` | All unit tests via Electron-as-Node |
| `npm run test:smoke` | Playwright smoke (floor / security / reports) |
| `npm run test:hell3000` | Full Hell 3000 integrated pass |
| `npm run test:chaos-monkey` | API + UI gremlin + destructive (uses `TGP_BASE_URL`) |
| `node tests/run-chaos-monkey.cjs` | Classic SSE / DB hammer / time-warp / long-haul |
| `node tests/lighthouse-reports/run-authed.cjs` | Authenticated Lighthouse (TRAINING MODE) |

### Throwaway API example

```bat
set ELECTRON_RUN_AS_NODE=1
set TGP_DATA_DIR=E:\Live\TGPV5\TGP_V5\resources\app\_chaos_infinity_data
set TGP_PORT=3102
set TGP_HTTPS_PORT=3546
set TGP_TEST_MODE=1
set TGP_SERVICE=1
set TGP_TRAINING_TEST=1
"%CD%\node_modules\electron\dist\electron.exe" server.cjs
```

Then:

```bat
set TGP_BASE_URL=http://127.0.0.1:3102
npm run test:chaos-monkey
```

### Chaos × infinity (heavy)

Recommended order (avoids the 12h hang):

1. `npm run test:hell3000` with **no** `TGP_PORT` / `TGP_DATA_DIR` in the shell
2. Start throwaway API on `:3102`
3. Loop `npm run test:chaos-monkey` (e.g. 25×) against `TGP_BASE_URL`
4. Optional: `node tests/run-chaos-monkey.cjs` with elevated `CHAOS_SSE_SURGE` / `CHAOS_DB_HAMMER`

Log from the agent run: `tests/chaos-infinity-run.log`.

### Stress env knobs (classic harness)

| Env | Default | Meaning |
|-----|---------|---------|
| `CHAOS_SSE_SURGE` | 200 | Reconnect surge client count |
| `CHAOS_DB_HAMMER` | 300 | DB hammer iterations |
| `CHAOS_LONG_HAUL_DAYS` | 14 | Simulated long-haul days |

## Lighthouse

- Runner: `tests/lighthouse-reports/run-authed.cjs`
- Outputs: `tests/lighthouse-reports/authed/`
- Auth: TRAINING MODE via `/api/mobile-auth` (needs `TGP_TEST_MODE=1` throwaway — live store rejects training login)
- Scoring note: runner uses **LAN / provided throttling** (no artificial 4× CPU / slow-3G). Matches store-local hosting.
- 2026-07-28 authed pass: **100 / 100 / 100 / 100** on all portals after CLS + a11y polish.

### Perf / CLS notes (product)

- Settings: flex `main` width locked (avoid shrink-to-fit → expand CLS)
- Reports: `public/css/reports-shell.css` + height reserves; Reports page eager in SPA
- Floor: `RestartRequiredBanner` is fixed overlay (does not push split layout)
- TV: meta/favicon/`<main>`/`defer` only — layout path unchanged

## Training Mode

Works on throwaway APIs with `TGP_TEST_MODE=1`. Live `:3001` returns 403 for TRAINING MODE unless training is explicitly enabled for that environment.
