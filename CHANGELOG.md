## 5.4.16 — 2026-08-06 (Period department freight allocation)

- **Authoritative landed cost** — Department Allocated Freight = Daily Freight Allocation Total (N3 / `freight_total`) × Period Department Allocation %; Landed = base dept purchases + allocated freight.
- **Not purchases × rate** — The 5.4.15 `period_rate` method is superseded/non-authoritative. Open periods use `period_department_allocation`.
- **Produce Shrink** — Receives freight when its confirmed period % is non-zero (template 12.2%). Zero-% departments stay $0 freight regardless of purchases.
- **Migration 064** — Period department allocation profiles + snapshots; day/department freight alloc storage; preserves `receiving_period_freight_rates` for audit without converting single rates into dept %.
- **Exact cents** — Largest-remainder allocation reconciles department shares to the daily N3 total (including negative freight credits).
- **Invoice freight_* / SMS bills** — Still reference/validation only. Bill variance = bills − sum of daily N3 totals.
- **Null vs zero** — Missing N3 stays incomplete; confirmed `$0.00` is a legitimate zero-freight day. Never `Number(null)→0`.
- **Preserved** — 5.4.15 audit tables, 5.4.14 dependency cleanup, and prior integrity controls.

## 5.4.15 — 2026-08-05 (Period-rate freight) — superseded by 5.4.16

- Introduced `period_rate` (Eligible Net Merchandise × Period Freight Rate%). **Superseded** by 5.4.16 workbook-equivalent department allocation.
- Migration 063 `receiving_period_freight_rates` retained for audit only under 5.4.16.
- Invoice freight_* / SMS bills remain reference/validation only.

## 5.4.14 — 2026-08-04 (Dependency cleanup)

- **Community `xlsx` removed** — Spreadsheet imports no longer depend on SheetJS community `xlsx@0.18.5`. Modern `.xlsx` uses ExcelJS; SMS legacy `.xls` uses `xls-reader` (BIFF).
- **Multer 2** — Investigation attachment uploads run on supported `multer` 2.x (limits, MIME allow-list, draft-lock behavior unchanged).
- **BIFF5 fallback** — Ancient BIFF5 or mislabeled HTML-as-xls files that fail parse: save as `.xlsx` or CSV and retry.
- **No schema migration** — Dependency-only release; `databaseUserVersion` / `latestMigration` remain **62** (migration 062 from 5.4.13).
- **Preserved** — 5.4.13 incident and inventory integrity, 5.4.12 backup integrity, 5.4.11 security access hardening, and 5.4.10 Receiving Book financial controls remain unchanged.

## 5.4.13 — 2026-08-04 (Incident and inventory integrity)

- **Investigation lock** — Submitted incident investigations reject patch/attach/delete/sign until a manager reopens; original `submitted_by` / `submitted_at` stay frozen; amend path is audited (migration 062).
- **Role-bound signatures** — Lead may be any Safe user; Safety Committee and Senior Management require Manager / Store Manager. Server stamps signer identity from the session.
- **Inventory permission** — New clerk grant `inventory` gates create/scan/edit/commit/reopen/finalize (managers always allowed). Grant intentionally in Staff settings.
- **Committed count integrity** — Non-open sessions reject line mutations; reopen clears that session’s `backstock_on_hand` memory; re-commit rewrites memory.
- **Preserved** — 5.4.12 backup integrity, 5.4.11 security access hardening, and 5.4.10 Receiving Book financial controls remain unchanged.

## 5.4.12 — 2026-08-04 (Backup and recovery integrity)

- **Verified backup packages** — Ops DB online `backup()`, inventory DB, incident attachments, store-transfer docs, and `manifest.json` with hashes; header-only SQLite junk is unhealthy.
- **Dual EOD backups** — Verified pre-purge package required to proceed; verified post-purge package required for EOD success. Failures persist durable status (migration 061) and do not claim success.
- **Honest reports & exports** — Historical BACKUP-labeled reports require a real backup source; live download and history export use verified packages, not live WAL copies.
- **Fail-closed migrations** — Pending migrations wait for a verified pre-migration package; snapshot failure blocks apply.
- **Preserved** — 5.4.11 security access hardening and 5.4.10 Receiving Book financial controls remain unchanged.

## 5.4.11 — 2026-08-04 (Security access hardening)

- **Fail-closed auth** — TRAINING MODE is disabled by default and revoked on upgrade (migration 060). Public login no longer enumerates managers or training identities.
- **Purpose-bound devices** — Station and TV writes require manager-issued purpose tokens. Bare station names and IP-only Authorized rows no longer authorize.
- **HTTPS-only LAN** — Store-network browsers must use HTTPS; non-loopback HTTP credential traffic receives 426. Existing devices must be re-paired with one-time HTTPS pairing URLs.
- **Readiness gates** — Production readiness fails for training access, tokenless mode, missing device purpose/token, and LAN without an active HTTPS listener.
- **Preserved** — 5.4.10 Receiving Book financial controls remain unchanged.

## 5.4.10 — 2026-08-03 (Receiving financial controls)

- **Authoritative workflow** — Operational periods can confirm only `invoice_freight`; submit and close share the complete live readiness gate.
- **Separation of duties** — Durable staff IDs prevent a submitting manager from approving the same period; reopen requires and audits a reason.
- **Close integrity** — Direct lock is retired; close alone atomically archives, snapshots, locks, and inserts a stable audit-outbox event.
- **Durable audit retry** — Outbox rows flush only after a verified manager-audit insert, retry idempotently at startup or through the manager retry endpoint, and expose pending warnings.
- **Authorization and certification** — Receiving staff retain daily entry while financial administration is manager-only; managers explicitly assert all six certification controls.
- **Browser regression** — A genuine two-manager workflow closes and exports Item X as $32.03 base/payable + $0.46 freight = $32.49 landed.

## 5.4.9 — 2026-08-03 (Receiving release integrity)

- **Persisted costing confirmation** — Submission and close require a stored valid method, manager, timestamp, and explanation. Submitted/approved status alone never implies historical confirmation.
- **Atomic snapshots** — `snapshotPeriod()` owns its transaction so current snapshot and immutable revision history either both commit or both roll back.
- **Operational activation response** — Successful activation returns `operational_period_start` for immediate client state synchronization.
- **Regression coverage** — Added tests for all three release blockers.

## 5.4.8 — 2026-08-03 (Receiving Book integrity completion)

- **Transactional deletion invalidation** — Invoice delete now records prior values, clears every partial/full certification control, invalidates freight override and overflow review, recomputes live reconciliation, and writes a financial audit in one database transaction.
- **Content-bound review controls** — Certification and freight overrides are checked against the live day fingerprint. Duplicate acknowledgements contain the normalized supplier/invoice plus exact sorted line set and become stale when a third line appears.
- **Manager workflows** — Financial Log now exposes daily certification, overflow acknowledgement, duplicate acknowledgement, negative freight credit reason, sales zero confirmation, and costing-method confirmation controls.
- **Authoritative close UI** — Close & lock now mirrors server `close_readiness` only; receiving warnings, stale certifications/overrides, incomplete sales, duplicates and overflow controls block both UI and backend close.
- **Migration 058** — Adds override/duplicate fingerprints and backfills immutable snapshot revision 1 from 5.4.7 current snapshots.
- **Export** — Inactive freight-reconciliation days are labeled `INACTIVE`; sheet has frozen/filterable headers and readable layout.

## 5.4.7 — 2026-08-03 (Receiving freight persistence + close integrity)

- **Freight save** — UI persists all `freight_*` fields with the line payload; freight modal has explicit Save; invalid freight blocks save; freight-only rows count as data.
- **Pagination / delete** — Delete uses `line_id`; pagination metadata is separate state (not array `.meta`); 51/101-line days remain fully accessible; paste overflow is explicit.
- **Authoritative freight recon** — One live reconciliation function for day report, certification, overview, close, snapshot, and export. Null expected is incomplete (not PASS). Close recomputes inside the transaction.
- **Manager controls** — Freight override and negative freight credits require manager + reason + audit; editing freight invalidates override and certification.
- **Certification / close** — Cert gates enforce receiver, references, expected freight, recon PASS/override, overflow ack, and duplicates. Sales blank ≠ confirmed zero (`receiving_report_sales_zero_confirm`). Snapshot revisions are immutable.
- **Exports** — All lines via styled continuation sheets; `Pulse Freight Reconciliation` worksheet; Item X and multi-method freight checks.
- **Security / nav** — PIN `1234` (env, file, or legacy) fails readiness (`error`); operational period activate is manager-only with explicit confirmation.
- **Migration 057** — Additive integrity schema for 5.4.6 upgrades.

## 5.4.6 — 2026-08-03 (Receiving financial integrity)

- **Invoice freight costing** — Primary period method is `invoice_freight` (base purchases + entered invoice-estimated freight by department). Landed inventory/COGS include freight once; invoice payable stays base + GST. Legacy fixed % allocation retained for historical periods and comparison only. `base_cost_only` is diagnostic — not labeled SMS landed.
- **Line freight + day reconciliation** — Per-invoice freight breakdown (not nine permanent columns); expected vs entered freight with $0.05 tolerance; manager override with reason/audit; daily certification.
- **Close integrity** — Structured readiness/model status; transactional close; sales history rebuild includes confirmed zeros; enriched period snapshots with costing method and revision.
- **No silent omissions** — Grid paginates past 50 lines; full-period export writes all lines (continuation sheets) and fails visibly unless 35 daily sheets succeed.
- **Session period viewing** — Viewing history uses `period_start` without changing the operational period setting; activate remains intentional.
- **Security** — Legacy PC_ADMIN default PIN is a persistent high-severity readiness failure until changed.

## 5.4.5 — 2026-08-02 (Financial workbook import error)

- **Import workbook no longer errors after success** — Financial Log import called undefined `broadcastUpdate` (and PDF commit referenced undefined `buildReportPayload`), so a good parse still returned an error. Both are wired correctly now.

## 5.4.4 — 2026-08-02 (Reopen saved order report)

- **Saved finalize report** — Pick list, clean order (with barcodes), and CSVs are stored on the order session. Past drafts show **VIEW / PRINT REPORT**; leaving the screen no longer loses print/CSV.

## 5.4.3 — 2026-08-02 (Clean order barcode report)

- **Clean order report** — Finalize shows a relay-ready report: Code128 barcode of the vendor #, description, and **WANTED** qty (remaining after backstock). **PRINT CLEAN ORDER** opens a print sheet. Check CSV stays available for verification; pick list CSV unchanged.

## 5.4.2 — 2026-08-02 (UPC check-digit match on backstock filter)

- **Order finalize matches UPC variants** — Backstock memory and order-draft scans of the same product (with/without check digit, or different digit strings that resolve to the same catalog item) now subtract correctly. Previously vendor lookup could succeed while exact-string UPC matching left the item on the clean order (e.g. Heinz ketchup).

## 5.4.1 — 2026-08-02 (Backstock commit memory + vendor clean order)

- **CLOSE & COMMIT backstock** — Closing a backstock walk writes UPC × bay/display into durable `backstock_on_hand` memory. Order finalize uses that memory (not open walks). Pick list still shows location; clean order CSV leads with **VENDOR_CODE** (SMS V.Code alias) + UPC for the relay. Catalog must be loaded for vendor match.

## 5.4.0 — 2026-08-02 (Order draft separate from labor clock)

- **`/count` Order draft** — Scan what you want to order as its own session type (`order`), completely separate from the floor labor order clock (`Order_Start` / finish gate). Finalize subtracts open backstock → **pick list** (fill shelf) + **clean order** CSV with barcodes/qty for the relay. Does not start, stop, or change labor inventory panels.
- **`/count` Backstock** (from 5.3.11) — Typed backstock walks concurrent with aisle counts; summary API feeds order finalize.

## 5.3.11 — 2026-08-02 (Backstock count walks)

- **`/count` Backstock button** — Start a typed backstock walk (optional bay label). Multiple backstock and aisle counts can run at the same time. Open/past lists split by type. CSV export includes `SESSION_TYPE`. Aggregate API `GET /api/inventory/backstock/summary` sums open backstock UPCs (foundation for order filter + pick list).

## 5.3.10 — 2026-08-01 (SMS bakery shrink .xls import)

- **Import SMS Inventory Count Report `.xls` / `.xlsx`** — Markdown → Shrink accepts the Edmonton “Inventory Count Report by SubDepartment” bakery/produce exports (e.g. `july27bakeryshrink.xls`). Reads Code + Description, qty from COUNT **Units** only (Variance / TtlQty ignored), and the report `Date:` into a historical closed count.
- **See imported counts in Markdown** — Historical imports no longer disappear into “today only”. Shrink shows a day picker, **Recent counts (all days)**, and jumps to the imported walk after confirm so the lines are visible immediately.

## 5.3.9 — 2026-08-01 (Concurrent shrink counts + CSV history)

- **Concurrent shrink counts** — Each walk is a session (like `/count` locations). Closing one count no longer blocks opening another the same day. Migration **054** `floor_shrink_sessions` + `session_id` on lines (legacy day lines backfilled).
- **Historical CSV import** — Import previous paper/CSV shrink counts as closed walks. Accepts `sku/upc/code`, optional `item`, `qty`, `reason`, `zone`, `store_date`. Skips SUBTOTAL/GRAND TOTAL rows from TGP exports. Live import still appends into the active open count.

## 5.3.8 — 2026-08-01 (Floor shrink analytics)

- **Shrink report by department** — Day print/CSV and the Markdown summary break out retail and cost by catalog department (Unassigned when no catalog match).
- **Controlled shrink reasons** — Logging uses Damaged / Outdated / Spoil / Theft / Vendor / Other (legacy free text still buckets for analytics).
- **Reports → Learn → Floor Shrink Analytics** — Range totals for cost (financial) vs retail (potential), coverage %, department and reason mix, top SKUs with drill-to-lines, by day and logged-by.

## 5.3.7 — 2026-08-01 (Shrink edit + close-out)

- **Edit or void a wrong shrink scan** — Each open line has EDIT (SKU, item, qty, reason). Changing the SKU re-pulls the catalog description. VOID drops the line from today's totals (kept for audit).
- **Close shrink count** — Finalize the day's open lines when the walk is done. Export still works afterward; REOPEN DAY if a correction is needed. New logs are blocked while the day is closed.
- **Migration 053** — `floor_shrink_sku.status` (`Open` / `Closed` / `Voided`) plus close metadata.

## 5.3.6 — 2026-08-01 (Stock with no barcode)

- **Items with no UPC are kept, filed under their vendor code** — Gift cards, handling fees, bakery and packaging have a blank Code cell in SMS (or a stub like `0`, `1`, `6`), so 3,211 real products were being dropped as "missing code". Each still carries its own `V.Code`, which is what the shelf tag shows and what staff type in, so the item is now filed under that. The import reports how many, because those cannot be scanned.
- **Repeated page headings counted honestly** — A reprinted heading row landed in "missing code" and could even be rescued into a product called "Description" under the code `V.CODE`. Heading rows are now recognised outright and reported as "repeated column header".
- **`/ui-shell` test no longer races the live store** — It booted the real app on port 3001, so it either failed on the port or, if the port was free, ran migrations and an EOD sweep against live store data. It now boots a throwaway store in a temp folder on a free loopback port.
- **A failed port bind no longer hangs the process** — Schedulers started before `listen()` were left running when boot rejected, so nothing could exit. Boot failure now stops them.

## 5.3.5 — 2026-08-01 (Catalog columns read from the rows)

- **Formatted SMS exports import whole** — SMS has no data-only export, and its printed report writes header labels into different cells than the rows beneath (`Code` lands in column 1 while the codes sit in column 0, and `Vendor` covers both the vendor number and its name). 5.3.4 could name the problem but still dropped ~96% of the file. The importer now works out the layout from the rows themselves whenever the header's code column does not hold codes: codes are long repeated-rarely integers, descriptions are unique text, and a vendor name repeats. A 33,930-product Price List now imports in full with its `V.Code` aliases.
- **Prices only stored when they hang together** — Retail, case cost, pack size and unit cost are accepted only when unit cost × pack lands near case cost, so a guessed column pairing is never written as money. The tolerance is deliberately loose: SMS unit cost carries freight the base case cost does not, so `4.18 × 6 = 25.08` against a `24.41` case still counts as agreement.
- **Repeated page headings ignored when reading the layout** — A printed report reprints its column headings every page; counting those as data hid the shape of the real rows.
- **Release gate cleanup** — Stale unit tests that still pointed at orphaned legacy files (`public/js/reports`, old `/rec` invoice label, settings classifier location) now assert the React surfaces. SQLite smokes in `verify:release` run under Electron-as-Node (ABI 145). Migration 051 creates/ensures price columns before seeding so an upgrade backup no longer fails mid-upsert.

## 5.3.4 — 2026-08-01 (Product catalog + scan match)

- **Product catalog** — `item_catalog` + aliases (migration 051). Settings → Product Catalog upload; Markdown FIFO/Shrink autofill descriptions from shelf code or UPC.
- **SMS ExcelFile upload** — Customer Price Catalog `.xls` / `.xlsx` imports directly (no CSV step); title/filter lines above the column header are skipped. Reads `UPC` as the scan code and `Case Code` as the shelf-tag alias. `Unit Code` is ignored — SMS derives it as `7` + the case code padded to seven digits.
- **UPC check-digit matching** — Scanner barcodes (with check digit) resolve to head-office codes filed without it; picking a name suggestion links the scanned code as an alias.
- **Scan replaces a stale description** — Markdown FIFO/Shrink previously only autofilled an empty description field, so the previous item's name stuck until it was deleted by hand. Scanning a different code now refills it; a name typed by hand is only replaced by a real catalog match.
- **Catalog cleanup** — Skips report headers / Excel scientific-notation mangled codes on import; manager cleanup removes non-product rows.
- **Excel cells read by value, not by display** — A 13-digit UPC in a general-format column shows as `9.78031E+12` but stores intact, so the importer now reads the stored value. Leading zeros Excel drops are harmless; codes normalize without them.
- **Every worksheet is imported** — Crystal Reports splits a long export across sheets; only the first was read, silently dropping the rest. Preview now reports rows read, sheet count, and the shortfall, and the audit ledger records skipped/error counts.
- **Price List with Cost** — Preferred SMS catalog upload (migration 052). Imports UPC, description, unit retail, unit cost, case cost, case pack, and the trailing number from `V.Code` as an alias.
- **Misaligned export is named, not swallowed** — A formatted Crystal export writes header labels into different cells than the rows beneath, so every description was read as a code and 96% of the file was dropped as "report title line". Import now detects which column really holds the codes and says so, and the preview shows the detected header, the column mapping, and sample skipped rows.
- **Scientific-notation check anchored** — `DOVE MEN BW ACTIVE + FRESH` contains `E+` once spaces are stripped and was being reported as a barcode Excel had rounded off.
- **Sync receiving day log** — Uses the same store-local evening-truck match as `/api/receiving/day-log`.
- **Catalog upload** — Capped at 15 MB (same class of guard as staff schedule import). The upload route carries its own body limit, since base64 inflates a file by a third and the global 10 MB JSON cap rejected an 8 MB export as "request entity too large"; oversized bodies now return a readable JSON error instead of an HTML page.

## 5.3.3 — 2026-07-30 (Floor / CS detail + richer CRM)

- **CS order notes** — Board cards can add/edit notes (shorts/reorders); print slip includes notes. Migration 047.
- **Count scan UX** — Scan mode suppresses soft keyboard; after scan, qty prompt before submit; TYPE UPC toggle.
- **Dual dry / frozen clocks** — Manager Labor data only; TV ACTUAL PPH still uses single `Order_Start`. Migration 048.
- **Markdown** — FIFO barcode-friendly entry; SHRINK tab + CSV import by SKU. Migration 049.
- **Richer CRM** — Email, address, tags, VIP/alert, activity log (call/short/reorder/etc.). Migration 050.
- **Action schema** — Whitelist `special_orders.notes*` and `counts.frozen_staff` so Labor/CS saves work after migrate.

## 5.3.2+ polish — 2026-07-28/29 (Lighthouse 100s + chaos gates + docs)

- **Accessibility / SEO** — Viewport, meta description, favicon, `<main>` landmarks, form labels, contrast fixes across portals + TV shell.
- **CLS** — Settings main width lock (flex shrink-to-fit fix); reports shell CSS + height reserves; floor restart banner as fixed overlay; training banner paints from auth user immediately.
- **Lighthouse** — Authed TRAINING MODE runner (`tests/lighthouse-reports/run-authed.cjs`); LAN / provided throttling; all portals **100/100/100/100** on throwaway API.
- **Chaos** — Hell 3000 strips inherited `TGP_PORT`/`TGP_DATA_DIR` so unit `startAppServer` cannot hang on port collision; Chaos App Monkey remains report-first.
- **Docs** — `docs/INDEX.md`, `docs/TESTING.md`; handoff bumped to 5.3.2.

## 5.3.2 — 2026-07-27 (CS harden + money fixes + orphan cleanup)

- **Produce shrink OCR** — Negative produce rollups land only in `produce_shrink` (no double-count into invoice totals).
- **Purchase rollups** — Daily purchases count `invoice` lines only; write-offs and spacers excluded.
- **CS / CS_Full session gate** — Beta board, CRM, due-orders, and print require a staff session; legacy desk (`CS_DESK` / `/api/action`) unchanged.
- **Orphan cleanup** — Removed legacy `mgr-settings.js`, mobile handlers/render, reports engine bundle, and root portal HTML; bookmarks still 301 to React routes.
- **Structure** — `CsApp` peeled into views + `useCsPortal`; Playwright CS selectors updated for React.

## 5.3.1 — 2026-07-27 (Financial Log freight + hardening)

- **Freight in purchases** — Daily freight is allocated into department purchase columns (Excel %) so margin grocery+dairy matches the EWM workbook.
- **Financial Log persistence** — Day/period load and save moved into `useLogPersistence` (date-race and header-flush rules in one place).
- **Receiving routes** — Split dock ops vs Financial Log report HTTP into separate modules; thin registrar unchanged for callers.
- **Settings guardrail** — New settings UI goes in React `/settings` only; do not grow legacy `mgr-settings.js`.
- Also includes prior 5.3.0 hardening: restart-safe order clocks, hostile money parse, EOD catch-up guards, persistent auth sessions.

### Patch 22 — TV display toggle apply fix
- TV `/api/sync` now exposes computed `tv_display` preferences.
- Native TV dashboard applies toggle settings directly to DOM visibility, including Store Comms and ticker guards.

## 5.3.0 — 2026-07-25 (Financial Log — EWM receiving workbook)

- **Financial Log** — Manager portal at **`/financial`** (legacy **`/log`** redirects here): 35-day Edmonton Wholesale Market receiving workbook — daily invoices, shrink, sales, margin, rebates, recounts, period close.
- **Shadow mode** — Default ON for private rollout; Settings → Store & TV toggle + allowlist; Management Hub link only for allowed managers until you turn shadow off.
- **Period workflow** — Submit → approve → close & lock (archive + snapshot); full workbook export no longer side-effects close.
- **Validation** — Duplicate invoice warnings, Excel copy-down total detection, dock reconciliation vs `/rec`; API blocks edits when period is submitted; checklist allows empty receiving days.
- **Import / help** — Workbook import dry-run preview; import loads rebates, recounts, and department margin sheets; help text documents manual Full workbook export after close.
- **Period guards** — `assertPeriodCloseReady()` on close; **Withdraw submission** for submitted periods; API blocks edits when submitted.
- **Windows service (headless API)** — WinSW service starts `server.cjs` at boot before login on port **3001**; `/rec`, `/financial`, mobile, and TV survive reboot. Install: `service/INSTALL.cmd`. Desktop `.exe` attaches UI-only when service owns `:3001`.
- **Schema** — Migrations 039–044 (`receiving_report_*`, shrink, analytics, extended sheets, period status, shadow settings).
- **Shortcuts / bookmarks** — No URL changes for floor portals (`/`, `/rec`, `/markdown`, `/cs`, `/reports`, `/settings`, `/count`, `/safe`). Version label on login updates to 5.3.0 only.

## 5.2.7 — 2026-07-24 (Store transfers workbook + receiving temp tweaks)

- **Store transfers** — `/rec` generates one Excel workbook with **Invoice** + **Manifest** tabs (ExcelJS; template formatting preserved). Lines from row 16; extended price in column J; manifest delivery date left blank.
- **Receiving temps** — Dry Grocery temp optional; **Grocery (chilled)** renamed **Perishables**.
- **Schema** — Migrations 037–038 (`store_transfers`, line items, manifest metadata).

## 5.2.6 — 2026-07-20 (Generated investigation PDF + Premium Load Rhythm)

- **Investigation PDF** — Export is a generated Letter report from the investigation schema (full typed text); no longer stamps the scanned Appendix B blank.
- **Premium Clerk Load Rhythm** — `/api/daily-rhythm` allows Premium Clerks (and Store Managers), matching the mobile Load Daily Rhythm button.

## 5.2.5 — 2026-07-19 (Incident investigations)

- **`/safe` Investigations** — INVESTIGATIONS tab: multi-step draft workflow, list, submit, and attachment support on the SAFE hub.
- **Appendix B PDF export** — Stamped corporate Appendix B PDF from submitted investigations.
- **Schema** — Migration 036 (`incident_investigations` + `incident_investigation_attachments`).

## 5.2.4 — 2026-07-19 (Inventory count feature toggle)

- **`Inventory_Count_Enabled`** — Default **OFF**. Settings → Store & TV toggle; `/count` shows a disabled screen; inventory APIs return 403 until enabled.
- **Migration 035** — Seeds the setting for upgrades.

## 5.2.3 — 2026-07-18 (Live camera over HTTPS)

- **Local HTTPS** — API also listens on `:3443` with a store-local self-signed cert (LAN IPs in SAN).
- **`/count` redirect** — HTTP LAN opens redirect to HTTPS so `getUserMedia` / LIVE CAMERA works on phones.
- **Snap harden** — Prefer native `BarcodeDetector`, then html5-qrcode with UPC/EAN formats.

## 5.2.2 — 2026-07-18 (Inventory camera + location history)

- **`/count` camera** — Live barcode scan via phone camera (html5-qrcode); wedge/typed entry still works.
- **Location sessions** — Start a count per aisle/bay; scans stay scoped to that location.
- **Past counts** — Export keeps history; reopen, edit UPC/qty, delete lines, re-export.
- **Schema** — `pulse_inventory.db` uses `count_sessions` + `count_lines` (migrates old `staged_counts`).

## 5.2.1 — 2026-07-18 (Supervisor bucket + rhythm assign tags)

- **Supervisor** — New schedule role tag / bucket. Store walks + direction huddle prefer Supervisor; Premium covers when Supervisor is off or not clocked in yet.
- **Rhythm Assign to** — Each rhythm task can pin to a schedule tag (or keep Auto from task text).
- **Schema** — Migration 034 (`assign_bucket` on `rhythm_tasks` + supervisor role rule).

## 5.2.0 — 2026-07-18 (Inventory count + markdown shelf qty)

- **`/count`** — Mobile inventory scan portal; isolated SQLite `data/pulse_inventory.db` (`staged_counts`); scan / active / CSV export+purge APIs.
- **`/markdown`** — Qty on shelf stepper (− / +) when logging expiration dates; stored on `kill_dates.quantity` (default 1).
- **Exports** — Kill-date print/CSV include QTY.
- **Schema** — Migration 033 adds `kill_dates.quantity`.

## 5.1.5 — 2026-07-16 (Board + cold chain + Prism)

- **Floor Comms** — Dismissed system messages stay dismissed across sync (no re-post flicker).
- **Prism UI** — Holo/bridge skin + display prefs only (no Pulse backend/migrations).
- **Routine cards** — Ice/silver contrast on Prism cyan.
- **Board** — Daily Direction first (prominent); Live Notices quieter underneath; both hidden when empty; task list labeled TASKS (mobile + TV).
- **Cold chain** — `/rec` PRINT COLD CHAIN (+ CSV) for BOL; Dry Grocery above 0°C; chilled/frozen out-of-range prompts two more spot checks; average + all three spots on log/print/CSV (`OUT OF TEMP`).
- **Schema** — Migration 030 adds `temp_spot_1/2/3` on `receiving_pallets`.

## 5.1.4 — 2026-07-13 (P2 same-class hardening)

- **Settings batch** — `/api/settings-batch` applies paired/multi settings in one transaction (notes+alert, profile toggles, Store/TV saves).
- **Shift lead** — Sync no longer auto-clears `Active_Manager`; exposes `active_manager_stale` / warning instead (`clear: true` still available for explicit cleanup).
- **EOD** — Snapshot failure records `Eod_Last_Snapshot_Error` and aborts destructive archive (first-boot `skipOrderHistoryArchive` still proceeds).
- **Rhythm** — Deferral lookup failure aborts seed instead of reseeding deferred templates.
- **Reports** — Login staff list and backup history show explicit errors instead of silent empty UI.

## 5.1.3 — 2026-07-13 (Same-class hardening)

- **Today-only mutations** — Rhythm defer, schedule reapply, and Daily Direction huddle close only touch tasks submitted on the store date (carryover Urgent/High left alone).
- **Order clock** — Generic `Order_Start` writes reject stuck `Order_End` / finished-today; `/rec` clock checkbox defaults off; `create_task` alone no longer starts the clock.
- **Dock sync** — `receiving_on_dock_error` surfaces on mobile/`/rec` instead of a silent empty dock.
- **EOD** — Resets `Hardware_Arrived` (+ hardware count); unfinished clocks archive with an EOD end stamp.

## 5.1.2 — 2026-07-13 (Clock/rhythm hardening + hub cleanup)

- **Rhythm** — Urgent/High carryover no longer blocks Routine seed (`alreadyLoaded` only when something was submitted today). Boot recovers carryover mornings.
- **Order clock** — TGP time out splits “post work” vs “start clock”; skips auto-start if an order already finished today or stuck `Order_End` is set; stuck clear uses atomic `/api/order-clock-reset`.
- **Receiving** — `/rec` remains the Chromebook pallet-scan station; mobile still shows dock + TIME IN/OUT and reminds staff to log TGP pallets on `/rec`.
- **Hub** — Removed unused System Analytics expander (use Reports).
- **Logging** — Rhythm failures and order-clock skip/start paths write structured app-log / recent-error entries.

## 5.1.1 — 2026-07-12 (Shift lead self-select + sync fix)

- **Fix** — `sync-payload.cjs` imports `reconcileActiveManager` / `listShiftLeadOptions` (was throwing at runtime for managers/premiums).
- **Shift lead** — Eligible Premium Clerks / Managers always appear in the Active shift lead dropdown (and pass save validation), so you can select yourself even if today's schedule import omitted you.
- Mobile render also ensures the logged-in eligible user is in the dropdown.

## 5.1.0 — 2026-07-12 (Single-store hardened + scale seams)

- **Store seams** — `Store_Instance_Id` (stable UUID) on settings; `getStoreMeta()` exposes `instanceId` for future multi-store without schema rewrite.
- **Security UX** — Stronger production-readiness checks; manager **Secure this store** opt-in (`Require_TV_Device_Token=1`); fresh-install PC_ADMIN PIN generation (upgrades keep prior behavior).
- **CI / E2E** — GitHub Actions `test:ci`; Playwright `webServer` so smoke no longer needs a manually started API.
- **Frontend** — Behavior-preserving extract of mgr-settings helpers into `public/js/mgr-settings/`.
- **Docs** — Version and JSON body-limit claims aligned to **5.1.0**; release track `single-store-hardened`.
- **Migration** — 029 store instance id.

**Manager / store docs (v5.1.0):** `resources/DOCUMENTATION_INDEX.md`, `README.md`, `PATCH_NOTES.md`, deploy checklists under `scripts/`.

## 5.0.0 — 2026-06-26 (Receiving floor + /safe inspections)

- **Receiving** — TGP pallet intake, cold chain report, work-order-only checkbox, TGP All Staff + clock rules.
- **`/safe`** — Monthly safety committee walk-through, printable paper form, Safe staff permission.
- **Inspections** — Findings logged only; managers review in Reports (no auto tasks).
- **Migrations** — 027 receiving pallets, 028 safety inspections.

**Manager / store docs (v5.0.0):** `resources/DOCUMENTATION_INDEX.md`, `README.md`, `PATCH_NOTES.md`, deploy checklists under `scripts/`.

## 4.8.0 — 2026-06-28 (Reports labor ledger & schedule intelligence)

- **Labor ledger** — Reports Today compares scheduled person-hours vs rhythm + order + fixed drag (Surplus / Tight / Under).
- **Order history** — FINISH roster, grocery/frozen/hardware columns, exception-reason rollup, staff-count curve, defer/ACK logs.
- **Handoff** — Shift lead and FINISH order crew on EOD summary.
- **Settings → Staff** — Schedule health strip, two-step import preview, name aliases, schedule guide.
- **Operational** — Labor STAFF independent of roster complement; rhythm re-apply explicit only; inbox ACK dedupe; Daily Direction dirty guards.

**Manager / store docs (v4.8.0):** `resources/DOCUMENTATION_INDEX.md`, `README.md`, `PATCH_NOTES.md`, deploy checklists under `scripts/`.

### 4.7.0-poc-rec-file-maintenance-page

- Added a File Maintenance Log section directly inside `/rec`.
- Shannon/file-maintenance staff can choose any receiving date and print/export the log without Reports access.
- `/rec` vendor time-out now asks for optional Invoice / Ref #.

## Patch 14 — Persistent Daily Safety Blurbs

- Added `safety_blurbs` and `daily_safety_focus` tables with migration 020.
- Seeded 20 grocery-safe daily blurbs, including safe cutting, spills, exits, ladders, chemicals, lifting, broken glass, and receiving safety.
- Added a Manager Settings tab to import/edit/disable blurbs and post or rotate today's safety focus.
- TV Safety Watch now shows Today's Safety Focus persistently for the store date.
- Reports now show the saved Daily Safety Focus for live and historical dates.
- Full History ZIP export now includes safety blurb and daily focus tables.

## 4.7.0 PoC Daily Direction TGP-day fix

- Daily Direction now treats a date as a TGP Order Day when the briefing is blank but store activity shows a TGP expected order, TGP work task, active order clock, archived order history, or TGP vendor schedule.
- The default floor message and Daily Direction day context no longer fall back to Non-TGP Day for real TGP days.
- Added regression tests for expected TGP orders with a blank order-day briefing.

## Patch 10 — Receiving Vendor Work Task Fix

- Time-in now stores the “Create receiving work task” checkbox choice on the vendor row.
- Time-out now closes the temporary receiving task and creates the follow-up “Work <vendor> order” task when that checkbox was selected.
- TGP order behavior is preserved: timing out a TGP vendor still starts the order clock and creates/keeps the TGP work task.
- Added migration 019 and regression tests for vendor receiving task creation.

## Patch 9 — Long-Term History, Trends & Rule-Based Insights

- Added configurable `Operational_Retention_Days` defaulting to 365 days.
- Added daily report snapshots so trends survive raw-row cleanup.
- Added Reports → Learn trend cards, explainable insights, Trend CSV export, and Full History ZIP export.
- Reports label the old `shrink_log` data as Outdated Items.

## 4.7.0 PoC Daily Direction reports patch

- Historical Reports now show the saved, manager-posted Daily Direction snapshot for the selected report date.
- Posted Shift Updates now appear with that historical Daily Direction after EOD.
- Added regression tests to ensure EOD does not purge `daily_direction` or `shift_updates`.

## 4.7.0 PoC tokenless store mode patch

- Kept trusted device token pairing available but made tokenless trusted-LAN display mode the default for the single-store PoC.
- Added `Require_TV_Device_Token` / `TGP_REQUIRE_DEVICE_TOKEN` escape hatch for stricter deployments.
- Added readiness visibility and tests for tokenless store mode.

## 4.7.0 PoC release confidence patch

- Added one-command `npm run verify:release` release confidence check.
- Added fresh-install and existing-store upgrade smoke scripts.
- Added pre-migration database snapshots for numbered migrations.
- Added release manifest shown in Manager Maintenance.

# TGP Command Center — Changelog

All notable changes to the store ops app (`resources/app`).

**Manager / store docs (v4.7.0):** `resources/DOCUMENTATION_INDEX.md`, `README.md`, `PATCH_NOTES.md`, `TGP_V4.5_SOP_Operating_Guide.md`, `NORMAL_DAY_WORKFLOW.md`, `MANAGER_RELEASE_BRIEF.md`, `CLERK_FLOOR_GUIDE.md`, `TGP_IT_DEPLOY_RUNBOOK.md`, `scripts/PHASE0_DEPLOY_CHECKLIST.txt`.

---

## 4.7.0 — 2026-06-21 (PoC LAN hardening)

### Security / PoC hardening
- **Public sync redaction** — `/api/sync` no longer returns TV access keys, presence gateway keys/maps, staff beacon maps, cart maps, or order gateway IDs to anonymous LAN clients.
- **Training PIN hygiene** — anonymous sync still lists the training profile name for walkthrough login, but does not publish the demo PIN.
- **Session token handling** — protected endpoints no longer accept session tokens in query strings; use `x-session-token` headers or existing JSON body token compatibility.
- **Regression coverage** — security audit tests cover public sync redaction and query-token rejection.

## 4.6.7 — 2026-06-08 (Shift lead hygiene + schedule health)

### Shift roster / schedule
- **EOD sweep** clears `Active_Manager` — confirm shift lead each morning in **Shift Roster**.
- **`Store Manager` staff role** + `shift_lead_eligible` — store managers excluded from Active Premium / Shift Lead dropdown and server validation.
- **Schedule health inbox** — warnings for missing schedule, unset/invalid shift lead, name mismatches, unclassified rows, FIFO owners not scheduled.
- **Auto re-apply** rhythm assignments after schedule import (today's range) and after schedule role override in Shift Roster.

---

## 4.6.6 — 2026-06-08 (Shift roster for premium leads)

### Shift roster
- **SHIFT ROSTER** expander is premium/manager-facing — shows **today's imported schedule** grouped by rhythm role (Premium, REC, Stock/Float, etc.).
- **Active Premium / Shift Lead** dropdown lists Premium Clerks, managers, and scheduled premium rows (stores `Active_Manager` for huddle + rhythm assign).
- **Settings → Staff:** `Rhythm_Schedule_Edit_Enabled` lets premium shift leads override imported schedule department/role and **Re-apply rhythm assignments** on open board tasks without reloading rhythm.
- Premium Clerks receive `staff_shifts` in sync (previously manager-only).

---

## 4.6.5 — 2026-06-13 (Rhythm schedule auto-assign)

### Daily rhythm
- **`rhythm-schedule-assign.cjs`** — builds assign context from `staff_shifts` + `Active_Manager` + `FIFO_Aisle_Assignments`.
- **06:00 rhythm load** assigns tasks: Stock/Float routines, REC for TGP Order, shift lead for huddle/store walk.
- **FIFO Audit** expands to `FIFO Audit — {aisles}` per FIFO assignment row when assignee is on today's schedule.
- Falls back to **Unassigned** when no schedule imported for today.

---

## 4.6.1 — 2026-06-09 (Expiry sold-through)

### Markdown / expiry
- **SOLD THROUGH** on 7-day and upcoming expiry rows (manager hub calendar, active list, mobile floor warnings, `/markdown` live board).
- Closes the kill-date row early — removes TV/mobile warnings and blocks AUTO-PULL task creation.

---

## 4.6.0 — 2026-06-08 (Settings Editor)

### Manager settings portal
- **`/settings` route** — dedicated Settings Editor window (rhythms, vendors, deliveries, store/TV, staff, task audit, TV pairing).
- **Hub cleanup** — configuration moved to Settings Editor; Daily Direction collapsed; **Today's Briefing** panel restored (scorecard + actions).
- **Betacs / tests** — store/TV toggles and Playwright flows updated for Settings Editor.
- **Electron dialogs** — all confirms/prompts use custom modals (native `confirm()` blocked in desktop shell).
- **Live refresh** — Settings Editor subscribes to `/api/stream` like Reports.

---

## 4.5.0 — 2026-05-19 (Ultimate ops pass)

### Manager hub parity with Reports
- **Order scorecard** on mobile (was null in sync) — live weekday averages from FINISH history.
- **Task planning** on mobile — APPLY / ADD TO RHYTHM without opening Reports.
- **Comms handoff preview** — EOD archive message count on manager hub.
- **`manager-hub-meta.cjs`** — single builder for sync manager_meta payload.

### Markdown / FIFO
- **Scan/OCR UI** on markdown tablet — photo/PDF → `/api/markdown/import-scan` → queue to batch.
- **Cloud OCR router** — `TGP_OCR_MODE=local|cloud|auto` + optional OpenAI vision (`TGP_OCR_API_KEY`).

### TV + Reports polish
- **TV presence strip** when BLE enabled — receiving hint + zone occupancy on native TV.
- **Reports pull list export** — print/CSV links in action inbox.

---

## 4.4.0 — 2026-05-19 (BLE presence — ultimate / cart-ready)

### Cart-first architecture (software now, hardware later)
- **Asset modes** — `staff` | `cart` | `both` drives FINISH hints, reports, and live board labels.
- **Cart registry** — `presence_assets` table + `POST/GET/DELETE /api/presence/assets`.
- **12-aisle template** — dumb battery aisle receivers (`AISLE-A01`…`A12`) + hub relay ingest (`forwarded[]` batches).
- **Gateway catalog** — kinds `hub` | `aisle` | `corner`; discovery auto-registers unknown IDs when allowed.

### Manager command center
- Asset mode selector, seed demo carts, enable aisle map, discovery toggle.
- Live board: hub/aisle/corner health, zone occupancy, cart/asset positions.
- Exceptions: unmapped BLE IDs, stale carts in receiving, offline aisle receivers.

### Dev tooling
- `scripts/presence-store-simulator.cjs` — full store tick (carts + aisle relay + hub).
- Migration **008** — assets, gateway catalog, snapshot `asset_mode` / `asset_details`.

---

## 4.3.0 — 2026-05-19 (BLE presence — production stack)

### Multi-gateway ingest
- **POST `/api/presence/ingest`** — ESP32/USB gateways authenticate with `X-Presence-Gateway-Key`; batch `seen[]` per corner.
- **Zone engine** — strongest-RSSI zone assignment (4-corner map), staff zone cache, gateway heartbeats, 48h event prune.
- **Migration 007** — `gateway_id`, `presence_gateway_heartbeats`, `presence_staff_zones`, default gateway map settings.

### Manager + FINISH integration
- **Live presence board** on mobile exception inbox; enable toggle under **BLE PRESENCE**.
- **FINISH gate** — receiving badge hint; mismatch warning when typed headcount differs by 2+ from BLE.
- **Order FINISH** — `order_presence_snapshots` with staff names at archive time.
- **Reports** — BLE presence section (snapshot + live gateways); gateway offline exceptions in inbox.

### Ops tooling
- `scripts/presence-gateway-simulator.cjs` — dev HTTP poster.
- `scripts/esp32/README.md` — production gateway wiring.

Default: **Presence_Enabled=0** until manager enables after hardware install.

---

## 4.2.5 — 2026-05-19 (Add to rhythm from planning)

### Task planning — promote recurring work
- **ADD TO RHYTHM** — rows with 3+ samples, not already in rhythm, and not grouped `PULL:*` can be promoted from Reports with learned `est_mins`.
- **APPLY** — only shown when a rhythm template already exists and estimates are off.
- **RHYTHM column** — shows In rhythm / Grouped pulls / Need 3+ samples when no action applies.
- `POST /api/reports/add-to-rhythm` (manager session).

---

## 4.2.4 — 2026-05-19 (Reports honesty + close the loop)

### FINISH archive quality (item 1)
- **Finish archive health scan** — 56-day window: complete order days, missing FINISH on order weekdays, incomplete rows, `phase0_ready`, scorecard trust band.
- **Reports + mobile hub** — FINISH archive health section; action inbox surfaces archive gaps.

### Historical reports honesty (item 2)
- **No live bleed** — past dates null out `tasks_open`, `orders_open`, `vendors_pending`; historical kill-date counts are as-of report date.
- **Missing archive** — historical days without FINISH show `archive_missing` instead of live piece counts.
- **OOS trends** — 30-day hotspots anchored to the report end date, not `date('now')`.
- **HISTORICAL VIEW** badge on Reports when viewing a prior day.

### Close the loop (item 4)
- **Action inbox ACK** — dismiss operational actions (not `missing_finish`); persisted in `Manager_Action_Acks`.
- **Rhythm defer** — defer advisor candidates for the store date; closes matching open Routine/General board tasks; daily rhythm skips deferred templates.
- **Apply estimates** — task planning APPLY updates `rhythm_tasks.est_mins` (including grouped FIFO Audit rows).

### API
- `POST /api/reports/ack-action`, `/defer-rhythm`, `/apply-rhythm-estimates` (manager session).

---

## 4.2.3 — 2026-05-19 (Reports historical date fix)

### Bug fix
- **Previous-day Reports 500** — Historical date/range views no longer crash when rhythm load advisor runs weekday SQL; store weekday casing normalized; legacy schema gaps handled safely; live-only manager exceptions suppressed on archived dates.

---

## 4.2.2 — 2026-05-19 (Reports intelligence)

### Actionable Reports
- **Action inbox** — Top of Reports: same manager exceptions as mobile (missing FINISH, scorecard outlier, rhythm late, urgent tasks, pulls, PPH, cold zones) plus operational gaps (open tasks, running order clock, scorecard building).
- **Executive KPI strip** — Urgent action count, tasks done/open, OOS logged, order pieces, ADJ PPH, scorecard days at a glance.
- **Order-day briefing** — Shows typical ADJ PPH; **Rhythm Load Advisor** hint on order days (heavy/light band + defer candidates).
- **Task planning accuracy** — Est vs actual summary by task type for the report range (under/over-estimated flags).
- **OOS trends** — 30-day zone hotspots alongside day-over-day comparison (data was in payload; now visible).

---

## 4.2.1 — 2026-05-19 (TV SSE + comms zones)

### Native TV live sync
- **SSE on native shell** — `tv-dashboard.js` connects to `/api/stream` (trusted TV IP) and refreshes within ~250ms of floor changes instead of waiting for the 90s poll.
- **No double-fetch** — native TV no longer runs two parallel `/api/sync` calls on each push; overlays follow `tgp-native-rendered`.
- **LIVE badge** — stream status reflects SSE + last successful sync.

### Message Center zone targeting
- **Zone picker on post** — pin, ticker, and feed forms include a zone dropdown (default store-wide).
- **Floor feed filter** — staff can set **My zone** to see store-wide messages plus zone-targeted posts; managers see all.
- **TV labels** — zone chips on pinned/feed; ticker prefixes zone-specific scroll text.

---

## 4.2.0 — 2026-05-19 (Message Center)

### Message Center (Phases A–C)
- **Three lanes** — `pinned` (board banner), `feed` (scannable list on mobile + TV), `ticker` (bottom scroll).
- **System messages** — Auto posts for rhythm-not-loaded, order running/finished, dock arrivals, pull-today count, OOS surge (`Comms_System_Messages` setting).
- **TV** — Pinned banner under header; FLOOR COMMS feed column; ticker uses Message Center when enabled.
- **Mobile** — Message Center panel (pin / ticker / feed), floor comms feed above tasks, admin list with dismiss + promote-to-pin.
- **EOD archive** — Active comms saved to `comms_handoff_archive`; Reports shows **Comms Handoff** section for that store date.

### Rollback
- **`Message_Center_Enabled`** — Manager toggle in Message Center panel (or `POST /api/comms/set-mode`). When off, legacy shift notes + old `ticker` table behavior returns unchanged.
- Existing ticker rows and shift notes migrate into Message Center on first DB migration (006).

---

## 4.1.1 — 2026-05-19 (floor ops fixes)

### Expiry / pull lists
- **Zone owner fix** — Outdated item owners now resolve from live `Zone_Mapping` (A1/A2/A6 → Zone 1, etc.) instead of every aisle mapping to Zone 2 / Ashley.
- **Printable pull list** — Manager hub **Print Pull List** + CSV export (`/api/export/kill-dates`): PULL TODAY + NEXT 7 DAYS warning, grouped with owner.

### Tasks & EOD
- **Urgent + High persist overnight** — EOD sweep no longer archives open Urgent or High tasks; Routine still sweeps.

### Order metrics
- **Order day = start date** — `shift_order_history.store_date` always anchors to clock start (not finish day).
- **Store-hours duration** — PPH/scorecard use minutes inside open hours (default **7:00** open, **20:00** close Mon–Sat, **18:00** Sun); raw clock span kept in `raw_clock_minutes` when order spans days.

---

## 4.1.0 — 2026-05-19 (Ultimate Evolution — phases 0–4)

### Platform (Phase 1)

- **Mobile modules** — `public/js/mobile.js` split into `core`, `ui`, `network`, `auth`, `render`, `map`, `stream`, `handlers`, `lifecycle` (loaded from `mobile.html`).
- **Store templates** — `store-templates/default/` JSON for rhythm, vendors, zone skeleton; first-run seed via `store-template.cjs`; manager `POST /api/store-template/apply`.
- **Schema migrations** — `src/migrations/` numbered runner replaces inline `ALTER TABLE` try/catch.
- **Native TV only** — Legacy React `dist/` TV deprecated; `TV_Native_Shell=1` is the supported path.

### Planning intelligence (Phase 2)

- **Order-day briefing** — Server `order-day-briefing.cjs`; reports + manager hub pre-order panel from weekday scorecard history.
- **Exception inbox v2** — Server `manager-exceptions.cjs` (missing FINISH, scorecard outlier, rhythm not loaded by 06:30) in sync `manager_meta`.
- **Rhythm load advisor** — Hints on Load Rhythm based on expected order size band (`rhythm-load-advisor.cjs`).

### Floor visibility (Phase 3)

- **Named staff at FINISH** — FINISH gate staff roster checkboxes; `staff_roster` JSON on `shift_order_history`.
- **Optional presence** — `beacon_events` / `order_presence_snapshots` tables + `Presence_Enabled` setting (off by default); superseded by `presence-engine.cjs` in 4.3+.

### Multi-store (Phase 4)

- **Store #2 kit** — `scripts/STORE_INSTANCE_SETUP.txt`.
- **HQ compare** — `scripts/hq-snapshot-compare.cjs` for exported scorecard JSON across stores.
- **Phase 0 checklist** — `scripts/PHASE0_DEPLOY_CHECKLIST.txt` (FINISH habit + scorecard validation).

---

## 3.4.6 — 2026-05-19

### Map — Aisle 5 (joint ownership)

- **Tri-color fill** — A5 interior uses orange / blue / green bands (wraps, Monin/Torani, coffee), matching other aisles’ fill opacity on mobile and TV.
- **Tri-color pulse** — When A5 has open tasks, border and fill pulse in a staggered tri-color cycle (not flat single-zone glow).
- **Pulse timing** — Active **2s**, High **1.6s**, Urgent **1s** — same as all other map sections.

### Docs

- **PATCH_NOTES 3.4.2** — Clarified that per-aisle FIFO rhythm tasks were reverted in 3.4.3 (one General FIFO task + aisle chart remains).

---

## 3.4.5 — 2026-05-19

### Reports

- **Weekly order scorecard** — Reports auto-compute averages from archived **clock days only** (start + end + duration): overall and by weekday (pieces, duration, staff, team PPH, adj/person). Uses last 90 days of `shift_order_history`.

### TV & mobile

- **TV High priority map** — Native TV floor map now uses distinct orange pulse for High tasks (parity with mobile), separate from routine active glow.
- **Shared zone owners** — `public/js/zone-owners.js` is the single client module for aisle → map-zone owner lookup; mobile and TV use it. Server `zone-owners.cjs` kept in sync (tested).

### Docs

- Removed stale 3.4.0 known limitations (order-history correction and TV High map gaps are fixed).

---

## 3.4.4 — 2026-05-19

### Map

- **General tasks** — No longer highlight the whole floor map (too distracting). FIFO Audit, store walk, huddle, etc. stay on the **task list** + **FIFO Aisle Assignments** panel only; map stays for zone-specific work.

---

## 3.4.3 — 2026-05-19

### FIFO & General tasks

- **FIFO Audit** — Back to one **General / Unassigned** rhythm task (no per-aisle named assignees). Staff use the **FIFO Aisle Assignments** panel for who covers which aisles that day.
- **General map styling** — Open **General** zone tasks now light up **every section** on the mobile + TV floor map (store-wide glow). Urgent/High zone tasks still win on their own sections. TV number badges count **local** tasks only (General does not show "5" on every tile).

---

## 3.4.2 — 2026-05-19

### Rhythm & General tasks

- **FIFO Audit production** — Brief experiment with per-aisle rhythm tasks from `FIFO_Aisle_Assignments` (**reverted in 3.4.3**; one General FIFO task + aisle chart is current).
- **Everyday rhythm repair** — Boot migration re-seeds missing Everyday rhythm templates if they were deleted from the DB.
- **Manual General tasks** — `General` added to mobile manual task zone dropdown.

### Task time metrics

- **EOD auto-archive excluded** — Tasks closed by `AUTO` (overnight EOD sweep) no longer affect learned `est_mins`, reports est-vs-actual, or zone/priority close counts. Human closes only.

### Timezone & reports

- **Store timezone normalize** — Typos like `America/eDMONTON` auto-correct to `America/Edmonton` on save and at runtime; invalid zones fall back to `America/Toronto`.
- **Order history correction** — Manager SAVE uses full grocery/frozen/hardware standard-hours math (same as FINISH path).
- **Load Rhythm messaging** — Clear notice when nothing is scheduled for today.

---

## 3.4.1 — 2026-05-19

### Daily rhythm reliability

- **Boot recovery** — If `Daily_Rhythm_Last_Loaded` is today but the board has zero open tasks, startup auto force-reloads rhythm (fixes blank board after overnight shutdown or partial load).
- **Force reload** — `POST /api/daily-rhythm` accepts `{ force: true }`; only reloads when the board is empty (won't duplicate tasks if work is already open).
- **Mobile** — Load Rhythm retries with force when stamp says loaded but board is empty.
- **Logging** — Every rhythm run writes to `tgp_error.log` (`alreadyLoaded`, task count, errors) for store-side diagnosis.
- **Refactor** — Rhythm logic extracted to `src/lib/daily-rhythm.cjs`; unit tests in `tests/daily-rhythm.test.cjs`.

### Upgrade notes (store PC)

Same as 3.4.0 — replace `resources/app/`, keep `tgp_ops.db` and `backups/`. Confirm **VERSION 3.4.1** on mobile login.

---

## 3.4.0 — 2026-05-19

### Order finish & archive

- **FINISH gate** — Ending an order now requires staff count (1–99) and **Hardware Arrived** confirmation before archive (`POST /api/order-finish`, mobile FINISH modal).
- **Archived order history** — Each FINISH writes a row to `shift_order_history` with grocery/frozen/hardware pieces, staff count, duration, and PPH metrics.
- **Legacy path preserved** — Old `Order_End` via settings still archives through the same finish logic (backward compatible).

### PPH & metrics

- **Break-adjusted per-person PPH** — Archived shifts apply tiered break deduction per person by clock hours (`<2h: 0`, `2–4h: 0.25`, `4–6h: 0.75`, `≥6h: 1.0`). Reports show **TEAM PPH**, **CLOCK/PERSON**, and **ADJ/PERSON**.
- **Hardware gating (live + archive)** — Hardware pieces and hours **do not** affect live PPH, EST HRS/PERSON, or archived totals until **Hardware Arrived** is checked. Hardware KPI tile still shows piece count for tracking.
- **Mobile PPH tile** — **ACTUAL PPH** KPI on mobile matches TV (live rate while clock runs; warning colour below standard).
- **Reports fix** — Hardware excluded from archived piece counts until marked arrived (same rule as live metrics).

### Tasks & planning

- **Learned task estimates** — After ≥3 closes in 90 days, `est_mins` updates from real completion times (rounded to 5 min). Wired on task close, daily rhythm, and kill-date pulls.
- **Floor display** — Estimated minutes **removed** from TV task cards and mobile floor task list (less noise on a multi-task board). Est vs actual **remains in reports**; manager task audit can still edit `est_mins`.

### Mobile & TV

- **High priority tasks** — Mobile task cards and zone map use distinct High styling (`data-high` / map colours). TV task cards and map now match (orange High pulse).

### Deploy & quality

- **`npm run verify:store`** — Preflight before copy: native module, version sync, core unit tests, TV bundle check (`scripts/verify-store-deploy.cjs`).
- **Store-site verify** — `scripts/verify-store-site.ps1` / `.cmd` for post-copy check on store PC (no Node required).
- **`prepare:store`** — Runs verify and writes `STORE_DEPLOY.txt` manifest.
- **Tests added/expanded** — `order-finish`, `task-estimates`, `shift-metrics` (hardware gating, break-adjusted PPH), order-history regression, full walkthrough / simulation / destructive suites.

### Manager / reports

- Order history table: editable start/end, staff, pieces; **SAVE** corrections; attach live clock; delete row.
- Warning when archived `staff_count = 1` makes ADJ/PERSON exceed team PPH — correct staff and save.

### Upgrade notes (store PC)

1. Stop `TGP Command Center V3.exe`.
2. Replace `resources/app/` from home build (`npm run prepare:store`).
3. **Do not** overwrite `tgp_ops.db` or `backups/`.
4. Confirm **VERSION 3.4.0** on mobile login.
5. Run `scripts\verify-store-site.cmd`.

---

## Prior versions

See git history or older backups for 3.3.x and earlier changes.


### 4.7.0 PoC recoverability patch
- Added backup restore drill script: `npm run verify:backup`.
- Added SQLite quick-check/WAL/table/backups/disk health helper.
- Added startup health logging and manager maintenance health endpoint.

### Patch 13 — Receiving print + TV safety watch
- Fixed Receiving Log, Expiry Pull, Weekly Trends, and HomeBase Audit exports after query-string session tokens were removed.
- Added a main TV Safety Watch panel that highlights open task-board safety hazards and optional TV_Safety_Message/Safety_Message text.

### 4.7.0 PoC receiving file-maintenance log patch
- Added optional Invoice / Ref # capture when timing out a vendor.
- Added a Receiving / File Maintenance Log printout and CSV for next-day invoice control.
- File Maintenance printout includes vendor, time in, time out, receiver, invoice/ref, and notes; no filed checkbox is required.

## Patch 17 — Receiving Vendor Cleanup
- Added canonical receiving vendor aliases to reduce duplicates like `coke`/`Coke`, `pepsi`/`pesis`, `Canada bread`/`Canada Bread`, and `complete`/`Complete`.
- Added a vendor picker/autocomplete to `/rec` for unscheduled vendor arrivals.
- Added migration 022 to normalize obvious existing receiving/vendor schedule rows while avoiding unsafe guesses for unknown junk values.
- Added regression tests for vendor alias normalization.
## 4.7.0 — Patch 18 Staff Schedule Alias Cleanup

- Added confirmed staff schedule aliases: Isabella→Izzy, Abigail→Abby, Jessica→Jess, Lenora→Nora.
- Explicitly keeps Jennifer O separate from Jenn because Jennifer O is no longer at the store.
- Marks Shanelle inactive/gone, Shannon as File Maintenance, and Connor/Dawn as pending staff so schedule mismatch warnings stay useful.
- Future schedule imports normalize confirmed aliases before rhythm auto-assignment.



## Patch 20 - TV Display Toggles

- Added manager-controlled TV display toggles that preserve the current layout by default.
- Toggles cover pinned Daily Huddle, Store Comms panel, auto/audit trail items, bottom ticker, and latest Shift Update feed items.
- Added migration 024 to seed the new TV settings on existing store databases.
