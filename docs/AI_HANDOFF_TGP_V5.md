# TGP Command Center v5.4.5 — AI Handoff Document

**Purpose:** Give another AI (or developer) enough context to work on this codebase without prior conversation history.

**Last updated:** 2026-08-02  
**App version:** 5.4.5 (`src/app-version.cjs`)  
**Primary workspace path:** `E:\Live\TGPV5\TGP_V5\resources\app`  
**Database:** `tgp_ops.db` (single SQLite file, WAL mode)  
**Default API port:** 3001  

**Doc map:** [docs/INDEX.md](./INDEX.md) · **Testing:** [docs/TESTING.md](./TESTING.md)

---

## 1. What this application is

**TGP Command Center** (internal name **Pulse**) is a single-store grocery operations platform for TGP (The Grocery People). It runs on a Windows PC at the store and serves:

- Floor staff mobile uplink (tasks, rhythm, comms)
- Receiving dock kiosk (`/rec`)
- Markdown/expiry tablet portal
- Customer service (`/cs`)
- Safe/investigations (`/safe`)
- Inventory count (`/count`, feature-gated)
- Manager reports (`/reports`)
- Settings editor (`/settings`)
- **Financial Log** (`/financial`) — Edmonton Wholesale Market (EWM) 35-day receiving workbook (manager-only)
- **TV dashboard** (`/tv`) — native HTML shell (default)

The stack is **Node.js + Express + better-sqlite3** backend, **React (Vite)** SPA for floor + portals, **Electron** desktop shell optional, **Windows service** (WinSW) for headless API at boot.

**UI ownership (critical):** React is the **only floor owner**. Live uplink and portals are `client/src/` → `dist/ui/`. Root `*.html` and legacy mobile/settings scripts are orphaned (301 redirects only). The remaining live non-SPA UI is **TV** (`/tv` → `public/tv/`). See `.cursor/rules/react-floor-owner.mdc` and `settings-react-only.mdc`.

### Design philosophy (critical for Financial Log)

The legacy EWM Excel workbook was built by a human with limited Excel knowledge and had long-standing errors (e.g. row copy-down duplicating invoice totals from the row above). The Financial Log portal is **not** a blind clone of broken Excel formulas. It:

- Validates data (duplicate invoices, copy-down total patterns)
- Recomputes margin from imported/captured inputs using explicit server-side formulas
- Runs in **shadow mode** by default until the store manager validates it against historical periods

Operational receiving (`/rec`) and financial receiving (`/financial`) are **intentionally separate**. Dock reconciliation compares them but does not auto-sync.

### Recent quality bar (5.3.2)

- Authenticated Lighthouse (throwaway `:3101`, TRAINING MODE): **100 Perf / A11y / BP / SEO** across portals (LAN scoring).
- Chaos App Monkey + Hell 3000 are the stability gates; see [TESTING.md](./TESTING.md).
- On-site 5.3.1 fixes were merged forward into this 5.3.2 tree before Thursday store deploy.
---

## 2. Repository layout (resources/app)

```
resources/app/
├── main.cjs                 # Electron desktop entry (UI shell)
├── server.cjs               # Headless Node API (Windows service uses this)
├── src/
│   ├── app-version.cjs      # Single source of truth for semver
│   ├── db.cjs               # SQLite connection, statement cache
│   ├── paths.cjs            # TGP_DATA_DIR, tgp_ops.db path
│   ├── api.cjs              # Express app assembly
│   ├── lib/
│   │   ├── app-boot.cjs     # Static routes, rate limits, React portal paths
│   │   ├── edmonton-receiving-report.cjs      # Daily sheets, lines, warnings
│   │   ├── edmonton-receiving-analytics.cjs    # Sales, margin, receiving totals
│   │   ├── edmonton-receiving-extended.cjs     # Rebates, recounts, dept margin, YTD
│   │   ├── edmonton-receiving-period-controls.cjs
│   │   ├── edmonton-receiving-shadow.cjs
│   │   ├── edmonton-receiving-dock-reconcile.cjs
│   │   ├── edmonton-receiving-workbook-import.cjs
│   │   ├── edmonton-receiving-workbook-export.cjs
│   │   ├── receiving-invoice-import.cjs        # PDF scan import for daily lines
│   │   └── ...
│   ├── migrations/          # Numbered 001–051, run once per DB
│   └── routes/manager/
│       └── receiving.cjs    # All /api/receiving/* including financial report
├── client/
│   └── src/
│       ├── App.jsx            # React routes
│       ├── log/               # Financial Log UI (LogApp.jsx, sheets, logApi.js)
│       ├── rec/               # Operational receiving UI
│       ├── settings/          # Settings editor tabs
│       └── ...
├── dist/ui/                   # Built React bundle (npm run build:ui)
├── store-templates/default/   # Excel templates for export/import
├── service/                   # WinSW Windows service install
├── tests/                     # Node unit tests + Playwright
├── docs/                      # This file
├── CHANGELOG.md
├── release-manifest.json
└── package.json
```

**Data directory (`TGP_DATA_DIR`):** Contains `tgp_ops.db`, `backups/`, logs. On store PC typically parent of `resources/app`. Never overwrite `tgp_ops.db` when deploying new app code.

---

## 3. Runtime and deployment

### How the store runs

1. **Windows service `TGP-CommandCenter`** runs `electron.exe` with `ELECTRON_RUN_AS_NODE=1` executing `server.cjs`.
2. Service start mode: **Automatic** (delayed auto-start). Survives reboot before user login.
3. API listens on **http://127.0.0.1:3001** (LAN accessible at store PC IP).
4. Desktop `.exe` can attach UI-only if service already owns port 3001.

### Deploy steps (summary)

```bash
cd resources/app
npm run rebuild:electron    # better-sqlite3 ABI 145 for Electron/service
npm run build:ui            # Vite → dist/ui/
node scripts/verify-store-deploy.cjs   # Must print VERIFY OK
```

Copy entire `resources/app` to store PC. **Do not** replace `tgp_ops.db`. Restart service. Confirm `/api/ready` shows version **5.4.5**.

### Version bump checklist

Sync these files: `src/app-version.cjs`, `package.json`, `release-manifest.json`, `CHANGELOG.md`, `PATCH_NOTES.txt`, deploy checklists, and [docs/INDEX.md](./INDEX.md). Run `verify-store-deploy.cjs`. Also `npm run build:ui` and restart the Windows service so `restart_required` clears.

---

## 4. URL routes and bookmarks (unchanged in 5.3.x)

| URL | Purpose | Auth |
|-----|---------|------|
| `/` | Mobile uplink / floor | Staff PIN |
| `/rec` | Operational dock receiving (time in/out, pallets) | Receiving permission |
| `/financial` | EWM financial workbook | Manager + shadow allowlist |
| `/log` | Redirect → `/financial` | — |
| `/markdown` | Expiry/markdown tablet | Staff |
| `/cs` | Customer service | CS permission |
| `/safe` | Safe + investigations | Safe permission |
| `/count` | Inventory count | Gated by `Inventory_Count_Enabled` |
| `/reports` | Manager reports dashboard | Manager |
| `/settings` | Settings editor | Manager |
| `/tv` | Store TV dashboard (native HTML) | Device trust / LAN |

Legacy `.html` bookmarks (`mobile.html`, `rec.html`, etc.) **301 redirect** to clean React paths — they are not a second live UI. **Version bumps do not change URLs** — existing Chromebook/phone bookmarks keep working.

React portal paths are registered in `src/lib/app-boot.cjs`. TV remains legacy at `/tv`.

---

## 5. Financial Log — overview

### Business purpose

Replaces the Edmonton Wholesale Market **35-day receiving report** Excel workbook used by the store manager for corporate reporting: daily invoice entry by department, freight allocation, shrink, sales numbers, margin calculations, rebates, recounts, period close.

### Frontend entry points

- `client/src/pages/LogPage.jsx` — PortalAuth (manager required) → `FinancialLogGate` → `LogApp`
- `client/src/log/FinancialLogGate.jsx` — Shadow access claim UI
- `client/src/log/FinancialLogLink.jsx` — Management Hub link (hidden unless `can_access`)
- `client/src/log/LogApp.jsx` — Main shell: nav, period workflow, all tabs
- `client/src/log/logApi.js` — All `/api/receiving/report/*` fetch wrappers
- `client/src/styles/log.css` — Spreadsheet-style UI

### Navigation structure (`logNavConfig.js`)

**Overview:** Period Checklist, Dock Reconcile, How to Use  
**Daily:** Receiving (grid), Shrink, Total Report  
**Sales:** Sales Numbers, Sales Data (archived weeks)  
**Margin:** Total Grocery, Centre Store, Dairy, Meat, Produce, Tobacco, Margin YTD  
**Period Close:** Receiving Totals, Rebates, Recounts  

Period-scoped tabs lazy-load via `GET /api/receiving/report/period?date=`.

### Daily receiving grid

- 50 rows × 11 department purchase columns + GST + invoice/supplier/notes
- Department columns match EWM: Grocery, Tobacco, Meat, Bakery, Bake Off, Deli, Produce, Produce Shrink, Dairy, Pharmacy, GST
- **Freight** allocated by fixed percentages (`logUtils.js` FREIGHT_LABELS / freightPct)
- Line kinds: `invoice` (default), `write_off` (supplier defaults to "WRITE OFF BOOK")
- **Write-off row** button in grid header
- Excel-style Tab/Enter navigation, multi-row paste (`LogSpreadsheetGrid.jsx`, `logGridNavigation.js`)
- Vendor autocomplete from union of `vendor_schedule`, historical suppliers, `expected_orders`

### Data validation (server-side)

`buildLineWarningsForDay()` in `edmonton-receiving-report.cjs`:

- **duplicate_invoice** — same normalized invoice # elsewhere in period
- **duplicate_total** — row total equals row above but different invoice (Excel copy-down error pattern)

Warnings returned on save and in `report.line_warnings` on day load. **Warnings do not block saves** (by design).

---

## 6. Database — Financial Log tables (migrations 039–044)

| Migration | Name | Creates |
|-----------|------|---------|
| 039 | edmonton_receiving_report | `receiving_report_day`, `receiving_report_lines`; setting `Receiving_Report_Period_Start` |
| 040 | receiving_shrink_lines | `receiving_shrink_lines`, `receiving_invoice_imports` |
| 041 | receiving_report_analytics | `receiving_report_sales`, `receiving_report_margin`; `Receiving_Report_Period_Number` |
| 042 | receiving_report_extended | `receiving_report_dept_margin`, `receiving_report_rebate_lines`, `receiving_report_recounts`, `receiving_report_sales_history`, `receiving_report_period_snapshots` |
| 043 | receiving_period_controls | `receiving_report_period_status` |
| 044 | financial_log_shadow | Settings `Financial_Log_Shadow_Mode=1`, `Financial_Log_Shadow_Allowlist=''` |

### Key tables

**receiving_report_day** — Per store_date: receiver_name, freight_total, period_start anchor  
**receiving_report_lines** — Invoice lines with all dept columns, line_kind, sort_order  
**receiving_shrink_lines** — SKU shrink detail (also aggregated for margin)  
**receiving_report_sales** — period_start + week_num + category_key + amount (29 sales categories)  
**receiving_report_margin** — Total Grocery inventory/margin meta per period  
**receiving_report_dept_margin** — Per-department margin meta (centre_store, dairy, meat, produce, tobacco)  
**receiving_report_rebate_lines** — Rebate invoice lines  
**receiving_report_recounts** — Inventory recount locations  
**receiving_report_period_status** — Workflow: open → submitted → approved → locked  
**receiving_report_period_snapshots** — JSON snapshots on close  
**receiving_report_sales_history** — Archived sales weeks  

Financial data lives in **the same `tgp_ops.db`** as operational data. It does not modify `expected_orders` or receiving pallets.

---

## 7. API — Financial Log routes

All report routes (except access endpoints) use `requireFinancialLogSession`:
1. `requireReceivingPermission` — manager role OR `receiving` permission in staff record
2. `canAccessFinancialLog` — shadow mode gate

### Shadow / access

| Method | Path | Auth | Purpose |
|--------|------|------|---------|
| GET | `/api/receiving/report/access` | Manager | Returns shadow_mode, allowlist, can_access, can_claim |
| POST | `/api/receiving/report/shadow/claim` | Manager | First manager claims allowlist when empty |
| PUT | `/api/receiving/report/shadow/settings` | Manager | Toggle shadow_mode, set allowlist (audited) |

Settings UI: **Settings → Store & TV → FINANCIAL LOG** section (`StoreTvTab.jsx`).

### Daily report

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/receiving/report?date=` | Full day payload incl. lines, shrink, line_warnings |
| PUT | `/api/receiving/report/day` | Save receiver, freight, period_start |
| POST | `/api/receiving/report/lines` | Create/update line; returns warnings[] |
| DELETE | `/api/receiving/report/lines/:lineId` | Delete line |

### Period dashboard

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/receiving/report/period?date=` | Aggregated period: sales, margin, dept_margins, rebates, recounts, dock_reconciliation, period_status, day_activity |
| GET | `/api/receiving/report/period-status?date=` | Period workflow status only |

### Analytics sheets

| Method | Path |
|--------|------|
| GET/PUT | `/api/receiving/report/sales` |
| GET | `/api/receiving/report/receiving-totals` |
| GET/PUT | `/api/receiving/report/margin` |
| PUT | `/api/receiving/report/dept-margin` |
| POST/DELETE | `/api/receiving/report/rebate-lines`, `/recounts` |
| GET | `/api/receiving/report/total-report` |
| GET | `/api/receiving/report/dock-reconciliation` |
| GET | `/api/receiving/report/vendors` |

### Shrink

| Method | Path |
|--------|------|
| GET | `/api/receiving/report/shrink?date=` |
| POST/DELETE | `/api/receiving/report/shrink-lines` |

### Import / export

| Method | Path | Notes |
|--------|------|-------|
| POST | `/api/receiving/report/import-workbook` | Full .xlsx; supports dry_run, replace_period, fill_sales |
| POST | `/api/receiving/report/import-scan` | PDF invoice OCR scan |
| POST | `/api/receiving/report/import-commit` | Commit PDF import |
| GET | `/api/export/edmonton-receiving-report?date=` | Single-day XLSX |
| GET | `/api/export/edmonton-receiving-report-period?date=` | Full period XLSX (**read-only, no archive side effects**) |

CLI import: `node scripts/import-edmonton-receiving-workbook.cjs "file.xlsx" [--dry-run] [--replace-period]`

### Period workflow

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/receiving/report/period/submit` | open → submitted |
| POST | `/api/receiving/report/period/approve` | submitted → approved |
| POST | `/api/receiving/report/period/close` | **approved → locked** via `closeAndLockPeriod()` (archive sales + snapshot + lock) |
| POST | `/api/receiving/report/period/lock` | Lock only (legacy) |
| POST | `/api/receiving/report/period/reopen` | Requires note; submitted/approved/locked → open |
| POST | `/api/receiving/report/sales-history/archive` | Manual archive |
| POST | `/api/receiving/report/period/snapshot` | Manual margin YTD snapshot |

**Period edit guard:** `assertPeriodEditable()` blocks mutations when status is `submitted`, `approved`, or `locked` (HTTP 423).

**Period close guard:** `assertPeriodCloseReady()` on `POST /period/close` enforces the same checklist as the UI (receiving ready, 5 sales weeks, opening/closing inventory).

---

## 8. Margin calculation (Total Grocery)

Implemented in `buildMarginPayload()` — `edmonton-receiving-analytics.cjs`.

### Inputs (from DB after import or manual entry)

- **Sales:** `buildSalesGrid()` — 29 categories from `receiving_report_sales`; grocery weekly total = sum of rollups **excluding** meat, tobacco, produce
- **Shrink:** From `receiving_shrink_lines` aggregated into grocery buckets (bakery, dairy, freezer, grocery) per week
- **Purchases for COGS:** Sum of **grocery + dairy** columns from daily receiving lines across period (`buildReceivingTotalsPayload`)
- **Inventory meta:** opening, closing, last from `receiving_report_margin` (imported from Total Grocery sheet cells)

### Formulas (recalculated server-side, not copied from Excel)

```
goods_available = opening_inventory + purchases
cogs            = opening_inventory + purchases - closing_inventory
gross_profit    = total_grocery_sales - cogs
gross_margin_pct = gross_profit / total_grocery_sales
shrink_adjusted_gp = gross_profit + total_shrink_dollars
sms_gp          = total_grocery_sales * sms_margin_pct
```

Import reads margin **meta** from Excel Total Grocery cells (B16/B19/B17/B11/B24/G4/G5/G7 etc.) via `readMarginMeta()` in workbook-import. **Final margin numbers are recomputed**, so penny-perfect match with Excel is not guaranteed — differences may expose Excel formula errors.

### Workbook import scope

**Imported:** daily sheets, sales numbers (or synthesized from Receiving Totals), shrink from Receiving Totals, Total Grocery margin meta, period number  
**NOT imported:** rebates, recounts, dept margin tabs, period workflow state  

---

## 9. Period workflow and close

### UI flow (`LogPeriodOverview.jsx`)

1. **Open** — editing allowed (unless shadow blocks access)
2. **Submit** — manager submits for review
3. **Approve** — second manager step (same person can do both in small store)
4. **Close & lock** — calls `POST /period/close` only (fixed in 5.3.0; previously broken sequence of archive + export + lock)

`closeAndLockPeriod()` in `edmonton-receiving-period-controls.cjs`:
- Requires status `approved`
- Runs `archivePeriodSalesToHistory`, `snapshotPeriod`, then `lockPeriod`
- Does **not** require period to be "editable"

### Checklist gates (`readyToClose`)

Requires period end passed, zero line warnings on days with receiving data (empty days OK), 5 sales weeks with data, and Total Grocery opening/closing inventory. Enforced in UI and on `POST /period/close` via `assertPeriodCloseReady()`. Dock reconcile mismatches are **informational only**.

### Read-only UI

When period status is `submitted`, `approved`, or `locked`, all editable tabs receive `readOnly={true}`.

---

## 10. Shadow mode

**Default:** ON (migration 044 sets `Financial_Log_Shadow_Mode=1`).

| Setting | Purpose |
|---------|---------|
| `Financial_Log_Shadow_Mode` | `1` = restrict portal; `0` = all managers |
| `Financial_Log_Shadow_Allowlist` | Comma-separated manager names |

When shadow ON and allowlist empty: first manager to open `/financial` can **claim** access. When shadow OFF: all managers see Financial Log link in Management Hub.

Operational staff never see `/financial` unless they are managers on the allowlist (or shadow is off).

---

## 11. /rec vs /financial

| | `/rec` | `/financial` |
|---|--------|--------------|
| Users | Receivers, floor | Manager (shadow gated) |
| Data | `expected_orders`, pallets, temps | `receiving_report_*` tables |
| Purpose | Operational dock log | Corporate EWM 35-day report |
| Sync | None automatic | Dock Reconcile compares vendor/arrival vs invoice lines |

---

## 12. Operational receiving (`/rec`) — brief

Separate codebase under `client/src/rec/`. Includes:

- Time in/out on expected orders
- Receiving pallets + cold chain temps
- File maintenance log
- Store transfers (Excel Invoice+Manifest workbook export, migration 037–038)

**Unchanged by Financial Log work.** Chromebook bookmarks to `/rec` remain valid.

---

## 13. Other major subsystems (context only)

- **Daily Rhythm** — Task seeding from templates + vendor schedule
- **Order clock** — TGP order day metrics, FINISH archive
- **Reports** — Labor, trends, action inbox, backups
- **Settings** — Rhythm, vendors, staff, TV, maintenance
- **Message center / TV** — Store comms, safety blurbs
- **CS / Safe / Count** — Separate portals with feature toggles

---

## 14. Testing

### Run financial unit tests (requires Electron ABI for better-sqlite3)

```bash
set ELECTRON_RUN_AS_NODE=1
npx electron --test tests/edmonton-receiving-period-controls.test.cjs
npx electron --test tests/edmonton-receiving-analytics.test.cjs
npx electron --test tests/edmonton-receiving-extended.test.cjs
npx electron --test tests/edmonton-receiving-import.test.cjs
```

### In `npm run test:unit` (CI)

- `edmonton-receiving-report.test.cjs` — yes
- `receiving-invoice-import.test.cjs` — yes
- **Not in CI:** period-controls, analytics, extended, import tests above

### No Playwright coverage for `/financial` yet

`tests/full-app-portals.spec.js` covers `/rec`, `/reports`, `/settings` — not financial.

---

## 15. Known gaps and gotchas (as of 5.3.0)

1. **Duplicate warnings** — Inform only; do not block save.
2. **Excel templates** — Export requires `store-templates/default/Template-Edmonton-Wholesale-Market-Receiving-Report.xlsx`; verify present on deploy machine (`verify-store-deploy.cjs`).
3. **Margin vs Excel** — Recalculated server-side; historical period import is the validation method (shadow mode).
4. **Dock reconcile at close** — Mismatch count is informational only; does not block close.
5. **Migration test** — `tests/migrations.test.cjs` expects 44 migrations.
6. **Playwright coverage** — `full-app-portals.spec.js` now includes `/financial`; deep workbook flows remain unit-tested only.

---

## 16. Key files quick reference

| Task | File(s) |
|------|---------|
| Add financial API route | `src/routes/manager/receiving.cjs` |
| Daily line logic | `src/lib/edmonton-receiving-report.cjs` |
| Margin/sales math | `src/lib/edmonton-receiving-analytics.cjs` |
| Period lock/close | `src/lib/edmonton-receiving-period-controls.cjs` |
| Shadow access | `src/lib/edmonton-receiving-shadow.cjs` |
| Workbook import | `src/lib/edmonton-receiving-workbook-import.cjs` |
| Workbook export | `src/lib/edmonton-receiving-workbook-export.cjs` |
| Financial UI shell | `client/src/log/LogApp.jsx` |
| Financial API client | `client/src/log/logApi.js` |
| Shadow settings UI | `client/src/settings/tabs/StoreTvTab.jsx` |
| New migration | `src/migrations/045_*.cjs` + update `migrations.test.cjs` count |
| Version bump | `src/app-version.cjs` + sync list in section 3 |

---

## 17. Suggested workflow for next AI session

1. Read this document + `CHANGELOG.md` 5.3.0 section.
2. If working on Financial Log: read `LogApp.jsx`, `edmonton-receiving-analytics.cjs` (margin), `edmonton-receiving-period-controls.cjs`.
3. Run `npm run build:ui` after frontend changes.
4. Run relevant tests via Electron-as-Node (see section 14).
5. For store deploy: `node scripts/verify-store-deploy.cjs` must pass.
6. Do not commit unless user asks. Do not overwrite `tgp_ops.db` on deploy.

---

## 18. User / product context

- Single store, manager-led validation of EWM replacement
- Shadow mode until manager compares historical periods (e.g. Period 9) to Excel
- User explicitly distrusts legacy Excel formula accuracy
- `/rec` shortcuts on Chromebooks and phones must never break
- Windows service must survive reboot for dock/tablet access
- Database stays unified in `tgp_ops.db` (no separate financial DB)

---

*End of handoff document.*
