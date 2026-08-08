export default function LogHelpGuide() {
    return (
        <div className="log-help-guide">
            <div className="sheet-banner">
                <div>
                    <div className="sheet-banner-title">How to Use the Receiving Report</div>
                    <div className="sheet-banner-sub">
                        Edmonton Wholesale Market · 35-day workbook · manager portal at <code>/financial</code>
                        {' '}· Pulse 5.4.16
                    </div>
                </div>
            </div>

            <section className="log-help-section">
                <h2>Quick start</h2>
                <ol className="log-help-steps">
                    <li>Bookmark <strong>/financial</strong> in your browser (manager login required).</li>
                    <li>
                        Choose the workbook period with the <strong>P7 / P8 / P9</strong> buttons (or <strong>All periods</strong>).
                        Viewing a period does not change the store’s operational period — use <strong>Set operational period</strong> when you mean to.
                    </li>
                    <li>Each day, open <strong>Daily → Receiving</strong>, pick the date, enter invoice lines, and <strong>certify</strong> active days.</li>
                    <li>
                        Configure and confirm the <strong>Period Department Allocation %</strong> profile
                        (Margin costing banner — Grocery through Pharmacy, must total 100%) before confirming costing.
                    </li>
                    <li>At period end, clear Model Status / readiness, then submit → approve → close &amp; lock (submitter ≠ approver).</li>
                </ol>
            </section>

            <section className="log-help-section">
                <h2>Costing (read this)</h2>
                <ul>
                    <li>
                        <strong>Authoritative method for open periods:</strong> <code>period_department_allocation</code>.
                        Only a confirmed department allocation profile may be used when confirming costing.
                    </li>
                    <li>
                        <strong>Department Allocated Freight</strong> = Daily Freight Allocation Total × Period Department Allocation %.
                        <strong>Landed Purchase Cost</strong> = eligible merchandise + Department Allocated Freight.
                    </li>
                    <li>
                        <strong>Daily Freight Allocation Total (N3)</strong> is the day-level freight pool allocated across departments.
                        Each department’s share is its confirmed allocation % — not a purchases × rate formula.
                    </li>
                    <li>
                        <strong>Invoice Estimated Freight — Reference Only</strong> (line <code>freight_*</code>)
                        is for recon and bill comparison. It never enters allocated freight, landed cost, COGS, or margin.
                        Do not confuse it with <strong>Daily Freight Allocation Total (N3)</strong>.
                    </li>
                    <li>
                        <strong>Freight Bill Validation Variance</strong> — actual freight bills validate period variance only.
                        Bills never replace department allocation on receiving records.
                    </li>
                    <li>
                        Missing or unconfirmed allocation profile → costing blocked (never silent 0%, never fall back to invoice estimate).
                        Confirming costing snapshots the profile so later edits do not rewrite prior periods.
                    </li>
                    <li><strong>Produce Shrink</strong> stays in purchases and <strong>receives freight allocation</strong> at its department %.</li>
                    <li>
                        Historical methods (<code>period_rate</code>, <code>invoice_freight</code>, <code>legacy_fixed_allocation</code>)
                        remain for closed/history comparison only — not authoritative for open periods.
                    </li>
                </ul>
            </section>

            <section className="log-help-section">
                <h2>Navigation</h2>
                <div className="log-help-grid">
                    <div className="log-help-card">
                        <h3>Overview</h3>
                        <p><strong>Period Checklist</strong> — Model Status, readiness, close workflow.</p>
                        <p><strong>Period buttons</strong> — P7, P8, P9… switch the whole workbook (* = count period).</p>
                        <p><strong>Dock Reconcile</strong> — compare /rec dock arrivals vs workbook suppliers.</p>
                    </div>
                    <div className="log-help-card">
                        <h3>Daily</h3>
                        <p><strong>Receiving</strong> — invoice grid; freight breakdown is reference-only under department allocation.</p>
                        <p><strong>Shrink</strong> — SKU-level shrink lines.</p>
                        <p><strong>Total Report</strong> — invoice numbers by week column.</p>
                    </div>
                    <div className="log-help-card">
                        <h3>Sales</h3>
                        <p><strong>Sales Numbers</strong> — weekly POS category totals (5 weeks).</p>
                        <p><strong>Sales Data</strong> — archived week columns for history.</p>
                    </div>
                    <div className="log-help-card">
                        <h3>Margin</h3>
                        <p>
                            Total Grocery plus department tabs, Margin YTD, <strong>Count Cycle</strong>,
                            and the costing comparison (department allocation vs reference invoice freight).
                        </p>
                    </div>
                    <div className="log-help-card">
                        <h3>Period Close</h3>
                        <p>Receiving Totals (daily N3 freight totals), Rebates, and Recounts.</p>
                    </div>
                </div>
            </section>

            <section className="log-help-section">
                <h2>Daily receiving sheet</h2>
                <ul>
                    <li>Use the <strong>day strip</strong> or week picker (Wk 1–5) to move between days.</li>
                    <li>Enter <strong>invoice number</strong>, <strong>supplier</strong>, and department dollar amounts. Rows save on blur.</li>
                    <li><strong>Tab / Enter</strong> moves to the next cell. <strong>Paste from Excel</strong> fills multiple cells.</li>
                    <li><strong>Supplier names</strong> autocomplete from your vendor schedule.</li>
                    <li>
                        Open <strong>Freight</strong> on a row to enter <strong>Invoice Estimated Freight — Reference Only</strong>
                        and to see Department Allocated Freight and Landed Purchase Cost when the allocation profile is applied.
                    </li>
                    <li>
                        Day strip Expected vs Entered freight is invoice-estimate recon — not the authoritative landed freight.
                        Material differences need a manager override reason before close.
                    </li>
                    <li>Duplicate invoice numbers in the same period show an <strong>orange warning</strong> after save.</li>
                    <li>Certify each active receiving day (six assertions tied to the content fingerprint) before close.</li>
                </ul>
            </section>

            <section className="log-help-section">
                <h2>Department allocation profile</h2>
                <ul>
                    <li>
                        On <strong>Margin</strong>, open the costing comparison banner and set each department % (Grocery, Tobacco, Meat, Bakery, Bake off, Deli, Produce, Produce Shrink, Dairy, Pharmacy).
                    </li>
                    <li>Live total must equal <strong>100%</strong> before you can confirm the profile.</li>
                    <li><strong>Save draft</strong> stores work in progress; <strong>Confirm profile</strong> requires a manager reason and locks the percentages for costing.</li>
                    <li><strong>Copy from previous period</strong> seeds the grid from the last confirmed profile.</li>
                    <li>After the profile is confirmed, use <strong>Confirm costing method</strong> to snapshot <code>period_department_allocation</code>.</li>
                </ul>
            </section>

            <section className="log-help-section">
                <h2>Load prior periods for a physical count</h2>
                <p>
                    Excel’s right-hand <strong>Periods N–N+2</strong> block needs opening inventory from the first period,
                    purchases and sales for all three periods, and closing from the physical count.
                </p>
                <ol className="log-help-steps">
                    <li>Dry-run → import <strong>Period 7</strong> (confirm department allocation profile if missing) → <strong>Snapshot</strong>.</li>
                    <li>Same for <strong>Period 8</strong> → snapshot.</li>
                    <li>Import <strong>Period 9</strong> (count period). Periods X–Y block imports counted closing when present.</li>
                    <li>Open <strong>Margin → Count Cycle</strong> on the count-period Sunday.</li>
                    <li>Use period buttons or <strong>All periods</strong> to review each imported period.</li>
                </ol>
                <p className="log-help-note">
                    Use replace only for bad/partial data. Locked periods must be reopened first.
                    Workbook import carries daily N3 freight totals and may restore a legacy audit rate — neither replaces the confirmed allocation profile.
                </p>
            </section>

            <section className="log-help-section">
                <h2>Count Cycle</h2>
                <ul>
                    <li>Mark <strong>This is a count period</strong> when grocery was physically counted.</li>
                    <li>Rollup = that period plus the prior two (sales, purchases, cycle open, counted close, COGS / GP).</li>
                    <li>Edit counted closing / cycle opening when unlocked. Left-side single-period margin may not match Count Cycle GP%.</li>
                </ul>
            </section>

            <section className="log-help-section">
                <h2>Imports &amp; exports</h2>
                <table className="log-help-table">
                    <thead>
                        <tr>
                            <th>Action</th>
                            <th>When to use</th>
                        </tr>
                    </thead>
                    <tbody>
                        <tr>
                            <td><strong>Import PDF</strong></td>
                            <td>Scan a vendor invoice or shrink document; review preview, then commit.</td>
                        </tr>
                        <tr>
                            <td><strong>Import workbook</strong></td>
                            <td>
                                Load a full Excel workbook. Use <strong>Dry run</strong> first.
                                Imports daily sheets (including N3 freight totals), sales, margin, rebates, recounts, dept margins, and Periods X–Y when present.
                                Confirm the department allocation profile on Margin after import — do not rely on legacy rate cells.
                            </td>
                        </tr>
                        <tr>
                            <td><strong>Daily XLSX</strong></td>
                            <td>Export one day’s sheet matching the official template.</td>
                        </tr>
                        <tr>
                            <td><strong>Full workbook</strong></td>
                            <td>
                                Export the entire 35-day period (includes daily freight allocation totals for round-trip).
                                Use after close &amp; lock when you need the corporate XLSX. Close does not auto-download.
                            </td>
                        </tr>
                    </tbody>
                </table>
            </section>

            <section className="log-help-section">
                <h2>Period close workflow</h2>
                <ol className="log-help-steps">
                    <li>
                        Clear Model Status: period end / final-day EOD, certified active days, freight recon (or override),
                        sales weeks (blank ≠ zero — confirm zeros), inventories, costing method confirmed with department allocation profile confirmed.
                    </li>
                    <li>Review <strong>Dock Reconcile</strong> (informational).</li>
                    <li><strong>Submit for approval</strong> — period becomes read-only. Submitter cannot also be the approver.</li>
                    <li><strong>Approve period</strong>.</li>
                    <li><strong>Close &amp; lock</strong> — archives sales, snapshots margin YTD, locks edits (atomic path).</li>
                    <li>Export <strong>Full workbook</strong> from the toolbar when needed.</li>
                </ol>
                <p className="log-help-note">
                    Withdraw submission while submitted, or Reopen after approve/lock — reason required and audited.
                </p>
            </section>

            <section className="log-help-section">
                <h2>/rec vs /financial</h2>
                <ul>
                    <li><strong>/rec</strong> — operational dock log: time in/out, pallets, expected deliveries (pair device purpose <code>receiving</code> over HTTPS).</li>
                    <li><strong>/financial</strong> — financial receiving workbook and department-allocation landed cost / margin.</li>
                    <li>Dock Reconcile spots vendors on the dock missing from the workbook (or vice versa).</li>
                </ul>
            </section>

            <section className="log-help-section">
                <h2>Tips</h2>
                <ul>
                    <li>Your last tab and date are remembered between visits.</li>
                    <li>Saving a line updates the day strip count without reloading the whole period.</li>
                    <li>Rebates and recounts are optional — add them only when your period requires them.</li>
                    <li>After deploy, run the app once so migrations through <strong>064</strong> (department allocation freight) apply.</li>
                </ul>
            </section>
        </div>
    );
}
