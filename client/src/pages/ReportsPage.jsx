import PortalAuth from '../components/shared/PortalAuth.jsx';
import ReportsApp from '../reports/ReportsApp.jsx';

export default function ReportsPage() {
    return (
        <PortalAuth
            title="TGP REPORTS"
            subtitle="Manager login required. Same PIN as TGP Center Store."
            buttonLabel="UNLOCK REPORTS"
            requireManager
        >
            <ReportsApp />
        </PortalAuth>
    );
}
