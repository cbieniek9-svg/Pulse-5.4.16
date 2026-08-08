const MODE_SECTIONS = {
    today: [
        { id: 'sec-daily-direction', label: 'Direction' },
        { id: 'sec-safety-focus', label: 'Safety' },
        { id: 'sec-labor-ledger', label: 'Labor' },
        { id: 'sec-actions', label: 'Inbox' },
        { id: 'sec-orders-today', label: 'Orders' },
    ],
    learn: [
        { id: 'sec-planning', label: 'Planning' },
        { id: 'sec-finish-health', label: 'Archive' },
        { id: 'sec-orders-learn', label: 'Orders' },
        { id: 'sec-exception-rollup', label: 'Exceptions' },
        { id: 'sec-staff-curve', label: 'Staff curve' },
        { id: 'sec-action-logs', label: 'Action logs' },
        { id: 'sec-trends', label: 'Trends' },
        { id: 'sec-floor-shrink', label: 'Shrink' },
        { id: 'sec-oos', label: 'OOS' },
        { id: 'sec-markdown', label: 'Markdown' },
        { id: 'sec-homebase', label: 'Homebase' },
    ],
    handoff: [
        { id: 'sec-summary', label: 'Summary' },
        { id: 'sec-order-roster', label: 'Crew' },
        { id: 'sec-comms', label: 'Comms' },
        { id: 'sec-staff', label: 'Staff' },
        { id: 'sec-tasks', label: 'Tasks' },
        { id: 'sec-customer-orders', label: 'Cust orders' },
        { id: 'sec-receiving', label: 'Receiving' },
        { id: 'sec-deliveries', label: 'Deliveries' },
        { id: 'sec-tgp-cold-chain', label: 'Cold chain' },
        { id: 'sec-safety-inspections', label: 'Inspections' },
    ],
};

export default function ReportSectionNav({ mode }) {
    const sections = MODE_SECTIONS[mode] || MODE_SECTIONS.today;

    const jump = (id) => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    };

    return (
        <nav className="report-section-nav" aria-label="Jump to report section">
            <span className="report-section-nav-label">Jump</span>
            {sections.map((s) => (
                <button key={s.id} type="button" className="report-section-chip" onClick={() => jump(s.id)}>
                    {s.label}
                </button>
            ))}
        </nav>
    );
}
