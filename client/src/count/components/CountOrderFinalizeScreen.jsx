import JsBarcode from 'jsbarcode';
import { downloadBlob } from '../countUtils.js';
import VendorBarcode from './VendorBarcode.jsx';

function moneyQty(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return String(n);
}

function barcodeValue(row) {
    return String(row?.vendor_code || row?.catalog_code || row?.upc || '').trim();
}

/** Qty still wanted from the vendor after backstock (clean order line). */
function wantedQty(row) {
    const n = Number(row?.order_qty);
    if (Number.isFinite(n) && n > 0) return n;
    const drafted = Number(row?.ordered_qty);
    return Number.isFinite(drafted) && drafted > 0 ? drafted : 0;
}

function escapeHtml(s) {
    return String(s ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function svgBarcodeHtml(code) {
    if (!code) return '<div class="code">NO VENDOR #</div>';
    try {
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        JsBarcode(svg, code, {
            format: 'CODE128',
            displayValue: true,
            fontSize: 14,
            height: 64,
            margin: 4,
            background: '#ffffff',
            lineColor: '#000000',
        });
        return svg.outerHTML;
    } catch (_) {
        return `<div class="code">${escapeHtml(code)}</div>`;
    }
}

function openCleanOrderPrint(clean, meta = {}) {
    const rows = (clean || []).filter((r) => wantedQty(r) > 0);
    const title = meta.label || 'Clean order';
    const when = meta.when || new Date().toLocaleString();
    const body = rows.map((r) => {
        const code = barcodeValue(r);
        const qty = wantedQty(r);
        const drafted = Number(r.ordered_qty);
        const draftedNote = Number.isFinite(drafted) && drafted > 0 && drafted !== qty
            ? `<div class="meta">Drafted ${drafted} · backstock applied ${moneyQty(r.backstock_qty)}</div>`
            : '';
        return `
          <article class="line">
            <div class="qty">WANTED <strong>×${qty}</strong></div>
            <div class="desc">${escapeHtml(r.description || '—')}</div>
            <div class="barcode-wrap">${svgBarcodeHtml(code)}</div>
            ${draftedNote}
          </article>`;
    }).join('\n');

    const html = `<!DOCTYPE html>
<html><head><meta charset="utf-8"/><title>${escapeHtml(title)}</title>
<style>
  body { font-family: Arial, Helvetica, sans-serif; color: #000; margin: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .sub { font-size: 12px; color: #444; margin-bottom: 16px; }
  .line { break-inside: avoid; page-break-inside: avoid; border-bottom: 1px solid #ccc; padding: 14px 0; }
  .qty { font-size: 22px; letter-spacing: 1px; margin-bottom: 4px; }
  .desc { font-size: 15px; margin-bottom: 8px; }
  .barcode-wrap { background: #fff; display: inline-block; padding: 6px 8px; }
  .barcode-wrap svg { max-width: 100%; height: auto; }
  .code { font-size: 14px; font-family: Consolas, monospace; }
  .meta { font-size: 11px; color: #666; margin-top: 4px; }
  @media print { body { margin: 8px; } .no-print { display: none; } }
</style></head><body>
  <button class="no-print" type="button" onclick="window.print()" style="margin-bottom:12px;padding:8px 14px;font-size:14px">Print</button>
  <h1>${escapeHtml(title)}</h1>
  <div class="sub">${escapeHtml(when)} · ${rows.length} line(s) · vendor barcodes · wanted qty</div>
  ${body || '<p>Nothing to order — backstock covered the draft.</p>'}
  <script>setTimeout(function(){ window.focus(); window.print(); }, 200);<\/script>
</body></html>`;

    const win = window.open('', '_blank');
    if (!win) {
        window.alert('Allow pop-ups to print the clean order report.');
        return;
    }
    win.document.open();
    win.document.write(html);
    win.document.close();
}

export default function CountOrderFinalizeScreen({
    result,
    error,
    busy,
    onBack,
    onDownloadPick,
    onDownloadClean,
}) {
    const pick = result?.pick_list || [];
    const clean = result?.clean_order || [];
    const totals = result?.totals || {};
    const label = result?.session?.location || 'Clean order';

    return (
        <div className="container">
            <div className="header">
                <div>
                    <div className="title">ORDER FINALIZED</div>
                    <div style={{ fontSize: '0.72em', color: '#888', marginTop: 4 }}>
                        Clean order report · vendor barcodes · wanted qty
                        {result?.cached ? ' · saved report' : ''}
                    </div>
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={onBack} disabled={busy}>
                    BACK HOME
                </button>
            </div>

            {error ? <div className="empty status-err">{error}</div> : null}

            {result ? (
                <>
                    <div className="card" style={{ marginBottom: 12 }}>
                        <div className="card-meta">
                            Wanted {totals.clean_units || 0} on clean order
                            {' · '}Pick {totals.pick_units || 0}
                            {' · '}Memory {totals.backstock_units || 0} units
                            {totals.vendor_matched != null ? ` · Vendor # ${totals.vendor_matched}` : ''}
                        </div>
                        <div className="row-actions" style={{ marginTop: 10 }}>
                            <button
                                type="button"
                                className="btn btn-sm btn-warn"
                                disabled={busy || !clean.length}
                                onClick={() => openCleanOrderPrint(clean, { label, when: new Date().toLocaleString() })}
                            >
                                PRINT CLEAN ORDER
                            </button>
                            <button type="button" className="btn btn-sm btn-secondary" disabled={busy || !pick.length} onClick={onDownloadPick}>
                                PICK LIST CSV
                            </button>
                            <button type="button" className="btn btn-sm btn-secondary" disabled={busy || !clean.length} onClick={onDownloadClean}>
                                CHECK CSV
                            </button>
                        </div>
                    </div>

                    <div className="section-label">CLEAN ORDER REPORT — vendor barcode · wanted qty</div>
                    {clean.length ? clean.map((r) => {
                        const code = barcodeValue(r);
                        const qty = wantedQty(r);
                        const drafted = Number(r.ordered_qty);
                        return (
                            <div key={`c-${r.upc}-${code}`} className="card clean-order-line">
                                <div className="clean-order-qty">
                                    WANTED <span className="scan-qty">×{qty}</span>
                                </div>
                                <div className="clean-order-desc">{r.description || '—'}</div>
                                {code ? (
                                    <div className="clean-order-barcode">
                                        <VendorBarcode value={code} height={52} displayValue />
                                    </div>
                                ) : (
                                    <div className="card-meta status-err">No vendor # — add catalog / V.Code for this UPC</div>
                                )}
                                <div className="card-meta" style={{ marginTop: 6 }}>
                                    {Number.isFinite(drafted) && drafted > 0 && drafted !== qty
                                        ? `Drafted ${drafted} · backstock ${moneyQty(r.backstock_qty)} · still order ${qty}`
                                        : `UPC ${r.upc || '—'}`}
                                </div>
                            </div>
                        );
                    }) : (
                        <div className="empty">Clean order empty — committed backstock covered the whole draft.</div>
                    )}

                    <div className="section-label">PICK LIST — where to pull</div>
                    {pick.length ? pick.map((r, i) => (
                        <div key={`p-${r.upc}-${r.location || ''}-${i}`} className="card">
                            <div className="loc-badge" style={{ marginBottom: 6 }}>
                                {r.location || 'Backstock'}
                                {' · '}
                                <span className="scan-qty">pick ×{r.pick_qty}</span>
                            </div>
                            <div className="scan-upc">{r.upc}</div>
                            <div>{r.description || '—'}</div>
                            <div className="card-meta">
                                at this spot {moneyQty(r.backstock_at_location ?? r.backstock_qty)}
                                {' · '}drafted {moneyQty(r.ordered_qty)}
                            </div>
                        </div>
                    )) : (
                        <div className="empty">Nothing to pick — no ordered items were in committed backstock.</div>
                    )}
                </>
            ) : null}
        </div>
    );
}

export function downloadTextCsv(text, filename) {
    downloadBlob(new Blob([text], { type: 'text/csv;charset=utf-8' }), filename);
}
