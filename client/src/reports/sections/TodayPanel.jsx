import { useReportsContext } from '../context/ReportsContext.jsx';
import DailyDirectionSection, { ActionInboxSection, SafetyFocusSection } from './DailyDirectionSection.jsx';
import LaborLedgerSection from './LaborLedgerSection.jsx';
import OrderTodaySection from './OrderTodaySection.jsx';

export default function TodayPanel({ data }) {
    const { reportMode } = useReportsContext();

    return (
        <div className={`report-mode-panel${reportMode === 'today' ? ' active' : ''}`} data-mode="today">
            <p className="mode-panel-intro">Today&apos;s operating command — act on direction and inbox items first.</p>
            <DailyDirectionSection data={data} />
            <SafetyFocusSection data={data} />
            <LaborLedgerSection data={data} />
            <ActionInboxSection data={data} />
            <OrderTodaySection data={data} />
        </div>
    );
}
