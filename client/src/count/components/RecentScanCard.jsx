import { formatTime } from '../countUtils.js';

function money(v) {
    const n = Number(v);
    if (!Number.isFinite(n)) return null;
    return n.toFixed(2);
}

export default function RecentScanCard({ scan, isLatest, onDelete }) {
    const cost = money(scan.unit_cost);
    const retail = money(scan.unit_retail);
    const qty = Number(scan.quantity) || 0;
    const extCost = cost != null ? money(Number(cost) * qty) : null;
    const extRetail = retail != null ? money(Number(retail) * qty) : null;
    return (
        <div className={`card ${isLatest ? 'just-scanned' : ''}`}>
            <div className="card-row">
                <div className="scan-main">
                    <div className="scan-upc">
                        {scan.upc}{' '}
                        <span className="scan-qty">×{scan.quantity} {scan.uom || ''}</span>
                    </div>
                    {scan.item_description ? (
                        <div className="card-meta">{scan.item_description}</div>
                    ) : null}
                    <div className="card-meta">
                        {formatTime(scan.scanned_at)}
                        {isLatest ? ' · latest' : ''}
                        {cost != null || retail != null
                            ? ` · cost ${cost ?? '—'} · retail ${retail ?? '—'}`
                            : ''}
                        {extCost != null || extRetail != null
                            ? ` · ext ${extCost ?? '—'} / ${extRetail ?? '—'}`
                            : ''}
                    </div>
                </div>
                <button
                    type="button"
                    className="btn btn-sm btn-danger"
                    onClick={() => onDelete(scan.id)}
                >
                    DELETE
                </button>
            </div>
        </div>
    );
}
