import { formatTime } from '../countUtils.js';

export default function SessionCard({ session, past = false, onContinue, onEdit, onReopenScan, onViewOrderReport }) {
    const isOrder = (session.session_type || '') === 'order';
    const showReport = isOrder && typeof onViewOrderReport === 'function'
        && (past || session.has_report || session.status === 'exported');

    return (
        <div className={`card ${past ? 'exported' : ''}`}>
            <div className="scan-upc">
                {(session.session_type || 'location') === 'backstock' ? (
                    <span className="scan-qty" style={{ marginRight: 6 }}>BACKSTOCK</span>
                ) : isOrder ? (
                    <span className="scan-qty" style={{ marginRight: 6 }}>ORDER</span>
                ) : (
                    <span className="scan-qty" style={{ marginRight: 6 }}>LOCATION</span>
                )}
                {session.status === 'committed' ? (
                    <span className="scan-qty" style={{ marginRight: 6 }}>IN MEMORY</span>
                ) : null}
                {session.location}{' '}
                <span className="scan-qty">{session.line_count || 0} lines</span>
            </div>
            <div className="card-meta">
                {past
                    ? (session.status === 'committed'
                        ? `Committed ${formatTime(session.exported_at)}`
                        : `Exported ${formatTime(session.exported_at)}`)
                    : `Started ${formatTime(session.created_at)}`}
                {session.created_by ? ` · ${session.created_by}` : ''}
                {' · '}
                {session.unit_count || 0} units
            </div>
            <div className="row-actions">
                {past ? (
                    <>
                        {showReport ? (
                            <button type="button" className="btn btn-sm btn-warn" onClick={() => onViewOrderReport(session.id)}>
                                VIEW / PRINT REPORT
                            </button>
                        ) : null}
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => onEdit(session.id)}>
                            VIEW / EDIT
                        </button>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => onReopenScan(session.id)}>
                            REOPEN &amp; SCAN
                        </button>
                    </>
                ) : (
                    <>
                        <button type="button" className="btn btn-sm btn-warn" onClick={() => onContinue(session.id)}>
                            CONTINUE
                        </button>
                        <button type="button" className="btn btn-sm btn-secondary" onClick={() => onEdit(session.id)}>
                            EDIT
                        </button>
                    </>
                )}
            </div>
        </div>
    );
}
