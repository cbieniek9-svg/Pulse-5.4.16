import PortalAuth from '../components/shared/PortalAuth.jsx';
import PortalBackBar from '../components/shared/PortalBackBar.jsx';
import SafeApp from '../safe/SafeApp.jsx';
import '../safe/safe.css';
import '../styles/portal-shell.css';

export default function SafePage() {
    return (
        <PortalAuth
            title="SAFETY INSPECTIONS"
            subtitle={(
                <>
                    Need <strong>Grant mobile login</strong> (Settings → Staff) plus Manager role or <strong>Safe</strong> permission.
                </>
            )}
            buttonLabel="ENTER /SAFE"
            backLabel="← Back to TGP Center Store"
            requireSafeAccess
        >
            <PortalBackBar backLabel="← FLOOR" />
            <SafeApp />
        </PortalAuth>
    );
}
