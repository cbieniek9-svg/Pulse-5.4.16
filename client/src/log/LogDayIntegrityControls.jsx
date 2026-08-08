import { useEffect, useState } from 'react';
import {
    acknowledgeDuplicateInvoice,
    acknowledgeOverflow,
    certifyReceivingDay,
} from './logApi.js';

const CERT_FIELDS = [
    ['receiving_complete', 'Receiving complete'],
    ['invoices_entered', 'Invoices entered'],
    ['references_verified', 'References verified'],
    ['freight_verified', 'Freight verified'],
    ['receiver_identified', 'Receiver identified'],
    ['exceptions_documented', 'Exceptions documented'],
];

export default function LogDayIntegrityControls({
    token,
    report,
    periodStart,
    isManager,
    readOnly,
    duplicateGroups = [],
    onRefresh,
}) {
    const [saving, setSaving] = useState('');
    const [assertions, setAssertions] = useState(
        () => Object.fromEntries(CERT_FIELDS.map(([key]) => [key, false])),
    );
    useEffect(() => {
        setAssertions(Object.fromEntries(CERT_FIELDS.map(([key]) => [key, false])));
    }, [report?.store_date, report?.certification?.cert_content_fingerprint]);
    if (!report) return null;
    const cert = report.certification || {};
    const duplicates = duplicateGroups;

    const certify = async () => {
        setSaving('certify');
        try {
            await certifyReceivingDay(token, {
                store_date: report.store_date,
                receiver_name: report.receiver_name,
                freight_total: report.expected_freight,
                ...assertions,
            });
            await onRefresh();
        } catch (error) {
            alert(error.message);
        } finally {
            setSaving('');
        }
    };

    const ackOverflow = async () => {
        const reason = window.prompt('Manager reason / confirmation for reviewing every overflow line:');
        if (!reason?.trim()) return;
        setSaving('overflow');
        try {
            await acknowledgeOverflow(token, { store_date: report.store_date, reason: reason.trim() });
            await onRefresh();
        } catch (error) {
            alert(error.message);
        } finally {
            setSaving('');
        }
    };

    const ackDuplicate = async (warning) => {
        const reason = window.prompt('Manager reason for acknowledging this duplicate supplier/invoice group:');
        if (!reason?.trim()) return;
        setSaving(`duplicate:${warning.exception_key}`);
        try {
            await acknowledgeDuplicateInvoice(token, {
                period_start: periodStart,
                exception_key: warning.key,
                line_ids: warning.line_ids || warning.lines?.map((line) => line.line_id) || [],
                reason: reason.trim(),
            });
            await onRefresh();
        } catch (error) {
            alert(error.message);
        } finally {
            setSaving('');
        }
    };

    return (
        <section className="day-integrity-controls" data-testid="day-integrity-controls">
            <h3>Daily financial controls</h3>
            <div className={report.certified ? 'integrity-status pass' : 'integrity-status warning'}>
                {report.certified
                    ? `Certified by ${cert.certified_by || 'manager'} at ${cert.certified_at || ''}`
                    : 'Not certified — all controls below must be valid.'}
            </div>
            <ul className="certification-assertions">
                {CERT_FIELDS.map(([key, label]) => (
                    <li key={key}>
                        {isManager && !readOnly ? (
                            <label>
                                <input
                                    type="checkbox"
                                    checked={assertions[key]}
                                    onChange={(event) => setAssertions((current) => ({
                                        ...current,
                                        [key]: event.target.checked,
                                    }))}
                                />
                                {label}
                            </label>
                        ) : (
                            <span>{cert[key] ? '✓' : '○'} {label}</span>
                        )}
                    </li>
                ))}
            </ul>
            {isManager && !readOnly ? (
                <button
                    type="button"
                    className="log-btn"
                    disabled={!!saving || !CERT_FIELDS.every(([key]) => assertions[key])}
                    onClick={certify}
                >
                    {saving === 'certify' ? 'Certifying…' : (report.certified ? 'Recertify day' : 'Certify day')}
                </button>
            ) : null}

            {report.line_overflow ? (
                <div className="integrity-exception">
                    <strong>{report.line_count} lines require overflow review.</strong>
                    <p>{report.overflow_acknowledged
                        ? `Acknowledged by ${report.overflow_acknowledged_by} — ${report.overflow_ack_reason}`
                        : 'A manager must acknowledge the exact current line set.'}</p>
                    {isManager && !readOnly && !report.overflow_acknowledged ? (
                        <button type="button" className="log-btn log-btn-secondary" disabled={!!saving} onClick={ackOverflow}>
                            {saving === 'overflow' ? 'Saving…' : 'Acknowledge overflow'}
                        </button>
                    ) : null}
                </div>
            ) : null}

            {duplicates.map((warning) => (
                <div key={warning.key} className="integrity-exception">
                    <strong>Duplicate invoice: {warning.supplier_key || 'Supplier'} / {warning.invoice_key || 'Invoice'}</strong>
                    <div>{(warning.line_ids || warning.lines?.map((line) => line.line_id) || []).join(', ')}</div>
                    {isManager && !readOnly ? (
                        <button type="button" className="log-btn log-btn-secondary" disabled={!!saving} onClick={() => ackDuplicate(warning)}>
                            Acknowledge duplicate
                        </button>
                    ) : null}
                </div>
            ))}
        </section>
    );
}
