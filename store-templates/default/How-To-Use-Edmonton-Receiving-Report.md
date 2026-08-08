# How to Use — Edmonton Wholesale Market Receiving Report

**Portal:** `/financial` (manager login required)  
**Legacy URL:** `/log` redirects to `/financial`  
**Purpose:** 35-day financial receiving workbook for the Edmonton Wholesale Market report  
**Operational dock log:** `/rec` (separate system — time in/out, pallets, deliveries)  
**Version notes:** Pulse **5.4.16** — department allocation freight is authoritative (migration **064**). Preserves 5.4.15 spreadsheet imports, 5.4.14 incident/inventory integrity, 5.4.12 verified backups, 5.4.11 purpose-paired HTTPS access, and Receiving Book close controls.

---

## Costing (read this)

- **Invoice payable** = base department amounts + GST. Estimated freight is **not** payable.
- **Authoritative landed cost** uses **period department allocation**:
  - **Department Allocated Freight** = Daily Freight Allocation Total × Period Department Allocation %
  - **Landed Purchase Cost** = eligible merchandise + Department Allocated Freight
- **Daily Freight Allocation Total (N3)** is the day-level freight pool allocated across departments by the confirmed profile.
- **Invoice Estimated Freight — Reference Only** (line `freight_*`) is for recon and bill comparison. It does **not** enter allocated freight, landed cost, COGS, or margin. Do not confuse it with Daily Freight Allocation Total (N3).
- **Freight Bill Validation Variance** — actual freight bills validate period variance only. Bills never replace department allocation on receiving records.
- Missing or unconfirmed allocation profile → costing blocked (never silent 0%, never fall back to invoice estimate). Confirming costing **snapshots** the profile so later edits do not rewrite prior periods.
- **Produce Shrink** stays in purchases and **receives freight allocation** at its department %.
- Period costing methods:
  - `period_department_allocation` — **primary** for open / operational periods (only method that may be confirmed)
  - `period_rate` — superseded comparison only (purchases × rate — audit / history)
  - `invoice_freight` — historical / reference comparison (invoice freight never lands into COGS)
  - `legacy_fixed_allocation` — alias of department allocation (closed history / comparison)
  - `base_cost_only` — diagnostic (freight excluded)
- Day freight strip: Expected (N3) vs Entered department freight vs Difference / Status — invoice-estimate recon. Unresolved material differences need a manager override reason before close.

---

## Quick start

1. Bookmark **`/financial`** in your browser.
2. Use the **P7 / P8 / P9** period buttons (or **All periods** menu) to **view** workbook periods — viewing does not change the store’s operational period. Use **Set operational period** when you intentionally want new receiving to land in that period.
3. Each day: **Daily → Receiving**, select the date within that period, enter invoice lines. Use **Freight** on a row for Invoice Estimated Freight (reference) and to see Department Allocated Freight / landed when the allocation profile is applied.
4. On **Margin**, set and confirm the **Period Department Allocation %** profile (must total 100%), then confirm **`period_department_allocation`** costing when ready.
5. Certify each active receiving day before close.
6. At period end (after final-day EOD / the day after period end): clear **Model Status**, then **Submit → Approve → Close & lock** (submitter ≠ approver).

---

## Navigation map

| Section | Tabs | Purpose |
|---------|------|---------|
| **Overview** | Period Checklist, Dock Reconcile, How to Use | Progress, model status, dock vs workbook match, this guide |
| **Daily** | Receiving, Shrink, Total Report | Day-to-day invoice entry and shrink detail |
| **Sales** | Sales Numbers, Sales Data | Weekly POS categories; archived history |
| **Margin** | Total Grocery, dept tabs, Margin YTD, **Count Cycle** | Inventory, GP, costing comparison, YTD, 3-period count rollup |
| **Period Close** | Receiving Totals, Rebates, Recounts | Daily N3 freight totals, end-of-period sheets |

---

## Department allocation profile

On **Margin → Costing comparison**:

1. Enter each department % (Grocery, Tobacco, Meat, Bakery, Bake off, Deli, Produce, Produce Shrink, Dairy, Pharmacy).
2. Live total must equal **100%** before confirm.
3. **Save draft** → work in progress; **Confirm profile** → manager reason required, locks percentages.
4. **Copy from previous period** seeds from the last confirmed profile.
5. After profile confirm, **Confirm costing method** snapshots `period_department_allocation`.

Optional: enter **Actual freight bills** for **Freight Bill Validation Variance** only — bills never change allocation.

---

## Lines over 50 / exports

- Pulse stores and totals **every** invoice line. The grid paginates when a day exceeds 50 rows — nothing is silently dropped.
- Full-period Excel export writes all 35 daily sheets (continuation sheets when a day exceeds 50 lines). If a day cannot be written, export **fails visibly** with diagnostics — it will not quietly skip dates.
- Export writes daily **Daily Freight Allocation Total** values for round-trip import.

---

## Loading prior periods for a physical count (P7 / P8 / P9)

The Excel **Periods N–N+2** block (e.g. Periods 7–9) is **not** the same as single-period Total Grocery GP%. Counted margin needs opening at the start of the first period in the cycle, purchases + sales for all three periods, and closing from the physical count.

**Import order:**

1. **Dry-run** import Period 7 workbook → confirm **department allocation profile** if missing → import → click **Snapshot**.
2. Same for **Period 8** → snapshot.
3. Import **Period 9** (count period). If the workbook has a right-hand Periods X–Y block, counted closing and cycle opening are stored automatically and the period is marked as a count period.
4. Open **Margin → Count Cycle** on the Period 9 Sunday to review the 3-period rollup.
5. Use the **P7 / P8 / P9** buttons (or **All periods**) to review each period’s day sheets.

Use **Replace existing period data** only when that period’s `period_start` already has bad/partial data. Locked periods must be reopened first.

You do **not** need P7/P8 for day-to-day Period 9 receiving — only for multi-period count truth and history.

---

## Count Cycle sheet

- Flag **This is a count period** when grocery was physically counted.
- Cycle = that period’s number plus the prior two (e.g. 7–8–9).
- Shows sales/purchases by period, cycle opening, counted closing, COGS / GP$ / GP% for Total Grocery and each dept.
- Editable counted closing and cycle opening when the period is unlocked.
- Single-period Margin tabs answer a different question; they may not match Count Cycle GP%.

---

## Daily receiving sheet

- Use the **day strip** or **Wk 1–5** buttons to move within the 35-day period.
- Enter **invoice number**, **supplier**, and department dollar amounts.
- Rows **save on blur** (when you leave the cell).
- **Tab / Enter** — move to the next cell.
- **Paste from Excel** — copy rows in Excel, click a cell, paste (tab-separated values fill across and down).
- **Supplier autocomplete** — names come from your vendor schedule; pick from the list for consistent spelling.
- **Freight** — per-invoice breakdown is **Invoice Estimated Freight — Reference Only**. Landed cost uses Daily Freight Allocation Total × department %, not invoice dollars.
- **Duplicate invoices** — if the same invoice number exists elsewhere in the period, an orange warning appears on the row after save.

---

## Imports and exports

| Button | Use when |
|--------|----------|
| **Import PDF** | You have a scanned vendor invoice or shrink document |
| **Import workbook** | Loading a full Excel file. Use **Dry run** first. Imports daily sheets (N3 totals), sales, margin, rebates, recounts, dept margins, and Periods X–Y when present. Confirm allocation profile on Margin after import. |
| **Daily XLSX** | Export one day matching the official template |
| **Full workbook** | Export the entire period with all sheets (includes daily freight allocation totals for round-trip). Use after close & lock when you need the corporate XLSX. |

Legacy SMS `.xls` that fails to parse (BIFF5 / mislabeled HTML): save as `.xlsx` or CSV and retry (5.4.14).

---

## Period close workflow

1. **Model Status / readiness:** period end / final-day EOD, active days certified, freight recon or override, sales weeks (blank is not a confirmed zero), inventories, costing method confirmed, department allocation profile confirmed.
2. **Dock Reconcile:** resolve days where dock arrivals and workbook suppliers do not match (informational — does not block close).
3. **Submit for approval** — marks the period as submitted and read-only. Submitter and approver must be different managers.
4. **Approve period** — period stays read-only.
5. **Close & lock period** — archives sales, snapshots margin YTD, and locks all edits (atomic path).
6. **Full workbook** — click the toolbar button to export the XLSX. Close & lock does **not** auto-download the workbook.

**Withdraw submission / Reopen:** Use **Withdraw submission** while submitted, or **Reopen period** after approve/lock. A reason is required and the action is audited.

---

## /rec vs /financial

| Portal | What it tracks |
|--------|----------------|
| `/rec` | Dock operations: vendor arrival/departure, pallets, cold chain (pair device purpose `receiving` over HTTPS) |
| `/financial` | Financial workbook: department-allocation landed purchases, COGS, and margin for the EWM 35-day report |

Use **Dock Reconcile** to find vendors on the dock missing from the workbook (or logged in the workbook but not on the dock).

---

## Keyboard and grid tips

- **Tab** — next field; **Shift+Tab** — previous field.
- **Enter** — same as Tab (moves down/across the grid).
- Delete empty rows by clearing all fields and tabbing out; saved lines delete when emptied.
- Portal remembers your last tab and date between visits.

---

## Troubleshooting

| Issue | What to do |
|-------|------------|
| Date outside period | Adjust operational period / period start so the receiving date falls within 35 days |
| Cannot edit | Period may be submitted, approved, or locked — use Withdraw submission or Reopen period |
| Allocation profile missing | Set and confirm Period Department Allocation % on Margin costing banner |
| Import blocked | Locked periods cannot be overwritten; reopen first |
| Duplicate invoice warning | Verify it is not a double entry; same invoice on different days may be valid but worth checking |
| Dock mismatch | Confirm supplier name spelling matches vendor schedule; check /rec for that day |
| `.xls` import fails | Save as `.xlsx` or CSV and retry |

---

*Template file:* `store-templates/default/Template-Edmonton-Wholesale-Market-Receiving-Report.xlsx`
