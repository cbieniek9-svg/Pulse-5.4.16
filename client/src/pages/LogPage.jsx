import PortalAuth from '../components/shared/PortalAuth.jsx';
import LogApp from '../log/LogApp.jsx';
import FinancialLogGate from '../log/FinancialLogGate.jsx';
import '../styles/log.css';

export default function LogPage() {
    return (
        <PortalAuth
            title="FINANCIAL LOG"
            buttonLabel="ENTER FINANCIAL LOG"
            backLabel="← Back to TGP Center Store"
            requireManager={true}
        >
            <FinancialLogGate>
                <LogApp />
            </FinancialLogGate>
        </PortalAuth>
    );
}
