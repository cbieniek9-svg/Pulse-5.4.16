import { MODE_HINTS } from '../constants/printSections.js';
import { useReportsContext } from '../context/ReportsContext.jsx';

export default function ReportModeTabs({ data }) {
    const { reportMode, setReportMode } = useReportsContext();
    const kpi = data.report_kpi_strip || {};
    const fah = data.finish_archive_health || {};
    const urgent = kpi.actions_urgent || 0;
    const todayBadge = urgent ? <span className="mode-badge">{urgent} urgent</span> : null;
    const learnBadge = fah.phase0_ready === false ? <span className="mode-badge">archive</span> : null;

    const tabs = [
        { mode: 'today', label: 'TODAY — Command', badge: todayBadge },
        { mode: 'learn', label: 'LEARN — Weekly', badge: learnBadge },
        { mode: 'handoff', label: 'HANDOFF — EOD', badge: null },
    ];

    return (
        <>
            <nav className="report-modes" aria-label="Report modes">
                {tabs.map(({ mode, label, badge }) => (
                    <button
                        key={mode}
                        type="button"
                        className={`report-mode-tab${reportMode === mode ? ' active' : ''}`}
                        data-mode={mode}
                        onClick={() => setReportMode(mode)}
                    >
                        {label}
                        {badge}
                    </button>
                ))}
            </nav>
            <p className="report-mode-hint" id="report-mode-hint">
                {MODE_HINTS[reportMode] || MODE_HINTS.today}
            </p>
        </>
    );
}
