import { useMemo, useState } from 'react';
import { rangeLabelFromMeta } from '../lib/reportHelpers.js';

function money(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return `$${Number(n).toFixed(2)}`;
}

function pct(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return `${Number(n).toFixed(1)}%`;
}

export default function FloorShrinkSection({ data }) {
    const fs = data.floor_shrink || null;
    const rangeLabel = rangeLabelFromMeta(data);
    const [skuFilter, setSkuFilter] = useState('');

    const lines = useMemo(() => {
        const all = fs?.recent_lines || [];
        if (!skuFilter) return all;
        const key = String(skuFilter).replace(/^0+/, '');
        return all.filter((r) => {
            const sku = String(r.sku || '').replace(/^0+/, '');
            const code = String(r.catalog_code || '').replace(/^0+/, '');
            return sku === key || code === key || r.sku === skuFilter;
        });
    }, [fs, skuFilter]);

    if (!fs) {
        return (
            <div className="section" id="sec-floor-shrink">
                <div className="section-title">FLOOR SHRINK ANALYTICS — {rangeLabel}</div>
                <p style={{ fontSize: '0.75rem', color: '#b0b0b0', textTransform: 'none' }}>
                    No floor shrink data for this range yet. Log shrink from Markdown → Shrink.
                </p>
            </div>
        );
    }

    const t = fs.totals || {};
    const cov = fs.coverage || {};
    const depts = fs.by_department || [];
    const reasons = fs.by_reason || [];
    const topSkus = fs.top_skus || [];
    const byDay = fs.by_day || [];
    const byWho = fs.by_logged_by || [];

    return (
        <div className="section" id="sec-floor-shrink">
            <div className="section-title">FLOOR SHRINK ANALYTICS — {rangeLabel}</div>
            <p style={{ fontSize: '0.72rem', color: '#888', margin: '-6px 0 12px', textTransform: 'none' }}>
                Cost is cash already spent. Retail is potential sell-through left on the table.
                Voided lines are excluded. Departments and prices come from the product catalog.
            </p>

            <div className="summary-grid" style={{ marginBottom: 12 }}>
                <div className={`sum-card ${t.line_count ? 'warn' : 'ok'}`}>
                    <div className="sum-label">LINES</div>
                    <div className="sum-val" style={{ fontSize: '1.25rem' }}>{t.line_count || 0}</div>
                    <div className="sum-sub">QTY {t.quantity || 0}</div>
                </div>
                <div className="sum-card warn">
                    <div className="sum-label">COST (FINANCIAL)</div>
                    <div className="sum-val" style={{ fontSize: '1.25rem' }}>{money(t.financial_loss_cost ?? t.cost)}</div>
                    <div className="sum-sub">WHAT YOU PAID</div>
                </div>
                <div className="sum-card purple">
                    <div className="sum-label">RETAIL (POTENTIAL)</div>
                    <div className="sum-val" style={{ fontSize: '1.25rem' }}>{money(t.potential_loss_retail ?? t.retail)}</div>
                    <div className="sum-sub">WHAT YOU COULD HAVE SOLD</div>
                </div>
                <div className="sum-card">
                    <div className="sum-label">MARGIN GAP</div>
                    <div className="sum-val" style={{ fontSize: '1.25rem' }}>{money(t.margin_gap)}</div>
                    <div className="sum-sub">RETAIL − COST</div>
                </div>
            </div>

            <div className="summary-grid" style={{ marginBottom: 14 }}>
                <div className={`sum-card ${cov.priced_pct >= 80 ? 'ok' : 'warn'}`}>
                    <div className="sum-label">PRICED</div>
                    <div className="sum-val" style={{ fontSize: '1.1rem' }}>{pct(cov.priced_pct)}</div>
                    <div className="sum-sub">{cov.priced_lines || 0} / {cov.line_count || 0} LINES</div>
                </div>
                <div className={`sum-card ${cov.reasoned_pct >= 80 ? 'ok' : 'warn'}`}>
                    <div className="sum-label">WITH REASON</div>
                    <div className="sum-val" style={{ fontSize: '1.1rem' }}>{pct(cov.reasoned_pct)}</div>
                    <div className="sum-sub">{cov.reasoned_lines || 0} / {cov.line_count || 0} LINES</div>
                </div>
                <div className={`sum-card ${cov.dept_pct >= 80 ? 'ok' : 'warn'}`}>
                    <div className="sum-label">WITH DEPARTMENT</div>
                    <div className="sum-val" style={{ fontSize: '1.1rem' }}>{pct(cov.dept_pct)}</div>
                    <div className="sum-sub">{cov.dept_lines || 0} / {cov.line_count || 0} LINES</div>
                </div>
            </div>

            <div className="two-col" style={{ marginBottom: 14 }}>
                <div>
                    <div className="section-title" style={{ fontSize: '0.72rem', marginBottom: 8 }}>BY DEPARTMENT</div>
                    <div className="tbl-wrap">
                        <table>
                            <tbody>
                                <tr><th>DEPT</th><th>LINES</th><th>QTY</th><th>COST</th><th>RETAIL</th></tr>
                                {depts.length ? depts.map((d) => (
                                    <tr key={d.department}>
                                        <td style={{ color: 'var(--white)', fontWeight: 700 }}>{d.department}</td>
                                        <td>{d.line_count}</td>
                                        <td>{d.quantity}</td>
                                        <td>{money(d.cost)}</td>
                                        <td>{money(d.retail)}</td>
                                    </tr>
                                )) : (
                                    <tr><td colSpan={5} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO LINES</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
                <div>
                    <div className="section-title" style={{ fontSize: '0.72rem', marginBottom: 8 }}>BY REASON</div>
                    <div className="tbl-wrap">
                        <table>
                            <tbody>
                                <tr><th>REASON</th><th>LINES</th><th>QTY</th><th>COST</th><th>RETAIL</th></tr>
                                {reasons.length ? reasons.map((r) => (
                                    <tr key={r.reason}>
                                        <td style={{ color: 'var(--white)', fontWeight: 700 }}>{r.reason}</td>
                                        <td>{r.line_count}</td>
                                        <td>{r.quantity}</td>
                                        <td>{money(r.cost)}</td>
                                        <td>{money(r.retail)}</td>
                                    </tr>
                                )) : (
                                    <tr><td colSpan={5} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO LINES</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div className="section-title" style={{ fontSize: '0.72rem', marginBottom: 8 }}>
                TOP SKUS (BY COST)
                {skuFilter ? (
                    <button
                        type="button"
                        className="btn"
                        style={{ marginLeft: 10, fontSize: '0.65rem', padding: '2px 8px' }}
                        onClick={() => setSkuFilter('')}
                    >
                        CLEAR FILTER
                    </button>
                ) : null}
            </div>
            <div className="tbl-wrap" style={{ marginBottom: 14 }}>
                <table>
                    <tbody>
                        <tr>
                            <th>SKU</th><th>ITEM</th><th>DEPT</th><th>REASON</th>
                            <th>DAYS</th><th>QTY</th><th>COST</th><th>RETAIL</th>
                        </tr>
                        {topSkus.length ? topSkus.map((s) => (
                            <tr
                                key={`${s.catalog_code || s.sku}`}
                                style={{ cursor: 'pointer', background: skuFilter === (s.catalog_code || s.sku) ? 'rgba(168,85,247,0.12)' : undefined }}
                                onClick={() => setSkuFilter(s.catalog_code || s.sku)}
                                title="Show recent lines for this SKU"
                            >
                                <td style={{ fontFamily: 'ui-monospace, monospace' }}>{s.sku}</td>
                                <td style={{ color: 'var(--white)', fontWeight: 700 }}>{s.item || '—'}</td>
                                <td>{s.department}</td>
                                <td>{s.primary_reason}</td>
                                <td>{s.days_seen}</td>
                                <td>{s.quantity}</td>
                                <td>{money(s.cost)}</td>
                                <td>{money(s.retail)}</td>
                            </tr>
                        )) : (
                            <tr><td colSpan={8} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO SKU SHRINK IN RANGE</td></tr>
                        )}
                    </tbody>
                </table>
            </div>

            <div className="two-col" style={{ marginBottom: 14 }}>
                <div>
                    <div className="section-title" style={{ fontSize: '0.72rem', marginBottom: 8 }}>BY DAY</div>
                    <div className="tbl-wrap">
                        <table>
                            <tbody>
                                <tr><th>DATE</th><th>LINES</th><th>COST</th><th>RETAIL</th></tr>
                                {byDay.length ? byDay.map((d) => (
                                    <tr key={d.store_date}>
                                        <td>{d.store_date}</td>
                                        <td>{d.line_count}</td>
                                        <td>{money(d.cost)}</td>
                                        <td>{money(d.retail)}</td>
                                    </tr>
                                )) : (
                                    <tr><td colSpan={4} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO DAYS</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
                <div>
                    <div className="section-title" style={{ fontSize: '0.72rem', marginBottom: 8 }}>LOGGED BY</div>
                    <div className="tbl-wrap">
                        <table>
                            <tbody>
                                <tr><th>WHO</th><th>LINES</th><th>COST</th><th>RETAIL</th></tr>
                                {byWho.length ? byWho.map((w) => (
                                    <tr key={w.logged_by}>
                                        <td style={{ textTransform: 'none' }}>{w.logged_by}</td>
                                        <td>{w.line_count}</td>
                                        <td>{money(w.cost)}</td>
                                        <td>{money(w.retail)}</td>
                                    </tr>
                                )) : (
                                    <tr><td colSpan={4} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO LOGS</td></tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                </div>
            </div>

            <div className="section-title" style={{ fontSize: '0.72rem', marginBottom: 8 }}>
                RECENT LINES{skuFilter ? ` — ${skuFilter}` : ''}
            </div>
            <div className="tbl-wrap">
                <table>
                    <tbody>
                        <tr>
                            <th>DATE</th><th>SKU</th><th>ITEM</th><th>DEPT</th>
                            <th>REASON</th><th>QTY</th><th>COST</th><th>RETAIL</th><th>BY</th>
                        </tr>
                        {lines.length ? lines.map((r) => (
                            <tr key={r.id || `${r.store_date}-${r.sku}-${r.time_logged}`}>
                                <td>{r.store_date}</td>
                                <td style={{ fontFamily: 'ui-monospace, monospace' }}>{r.sku}</td>
                                <td style={{ color: 'var(--white)' }}>{r.item || '—'}</td>
                                <td>{r.department}</td>
                                <td>{r.reason_bucket || r.reason || '—'}</td>
                                <td>{r.quantity}</td>
                                <td>{money(r.line_cost)}</td>
                                <td>{money(r.line_retail)}</td>
                                <td style={{ textTransform: 'none' }}>{r.logged_by || '—'}</td>
                            </tr>
                        )) : (
                            <tr><td colSpan={9} style={{ color: '#444', textAlign: 'center', padding: 16 }}>NO RECENT LINES</td></tr>
                        )}
                    </tbody>
                </table>
            </div>
        </div>
    );
}
