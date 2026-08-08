import DetailLineCard from './DetailLineCard.jsx';
import { formatTime } from '../countUtils.js';

export default function CountDetailScreen({
    session,
    lines,
    lineCount,
    loadError,
    onBack,
    onExport,
    onPrint,
    onCloseLocation,
    onFinalizeOrder,
    onViewOrderReport,
    onCloseBackstock,
    onReopen,
    onContinueScan,
    onRename,
    onSaveLine,
    onDeleteLine,
}) {
    const isOpen = session?.status === 'open';
    const isOrder = (session?.session_type || '') === 'order';
    const isBackstock = (session?.session_type || '') === 'backstock';
    const isLocation = !isOrder && !isBackstock;
    const title = isOrder
        ? (isOpen ? 'OPEN ORDER DRAFT' : 'PAST ORDER DRAFT')
        : isBackstock
            ? (isOpen ? 'OPEN BACKSTOCK' : 'COMMITTED BACKSTOCK')
            : (isOpen ? 'OPEN LOCATION COUNT' : 'CLOSED LOCATION COUNT');

    return (
        <div className="container">
            <div className="header">
                <div>
                    <div className="title">{title}</div>
                    <div className="loc-badge">{session?.location || '—'}</div>
                    {session ? (
                        <div className="card-meta" style={{ marginTop: 6 }}>
                            {`${session.status.toUpperCase()} · ${lineCount || 0} lines · ${formatTime(session.exported_at || session.created_at)}`}
                        </div>
                    ) : null}
                </div>
                <button type="button" className="btn btn-secondary btn-sm" onClick={onBack}>
                    BACK
                </button>
            </div>

            {session ? (
                <div className="row-actions">
                    {isOrder && typeof onViewOrderReport === 'function' ? (
                        <button type="button" className="btn btn-sm btn-warn" onClick={onViewOrderReport}>
                            {isOpen ? 'PREVIEW REPORT' : 'VIEW / PRINT REPORT'}
                        </button>
                    ) : null}
                    <button type="button" className="btn btn-sm" onClick={onExport}>
                        {isOrder ? 'EXPORT RAW CSV' : 'EXPORT CSV'}
                    </button>
                    {isLocation && typeof onPrint === 'function' ? (
                        <button type="button" className="btn btn-sm btn-secondary" onClick={onPrint}>
                            PRINT
                        </button>
                    ) : null}
                    {isLocation && isOpen && typeof onCloseLocation === 'function' ? (
                        <button type="button" className="btn btn-sm btn-warn" onClick={onCloseLocation}>
                            CLOSE COUNT
                        </button>
                    ) : null}
                    {isBackstock && isOpen && typeof onCloseBackstock === 'function' ? (
                        <button type="button" className="btn btn-sm btn-warn" onClick={onCloseBackstock}>
                            CLOSE &amp; COMMIT
                        </button>
                    ) : null}
                    {isOrder && isOpen && typeof onFinalizeOrder === 'function' ? (
                        <button type="button" className="btn btn-sm btn-warn" onClick={onFinalizeOrder}>
                            FINALIZE ORDER
                        </button>
                    ) : null}
                    {isOpen ? (
                        <button type="button" className="btn btn-sm btn-secondary" onClick={onContinueScan}>
                            CONTINUE SCAN
                        </button>
                    ) : (
                        <button type="button" className="btn btn-sm btn-secondary" onClick={onReopen}>
                            REOPEN
                        </button>
                    )}
                    <button type="button" className="btn btn-sm btn-secondary" onClick={onRename}>
                        RENAME LOCATION
                    </button>
                </div>
            ) : null}

            <div className="section-label">LINES</div>
            {loadError ? (
                <div className="empty status-err">{loadError}</div>
            ) : lines.length ? (
                lines.map((line) => (
                    <DetailLineCard
                        key={line.id}
                        line={line}
                        readOnly={!isOpen}
                        allowUnitUom={isLocation}
                        onSave={onSaveLine}
                        onDelete={onDeleteLine}
                    />
                ))
            ) : (
                <div className="empty">No lines.</div>
            )}
        </div>
    );
}
