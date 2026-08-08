import PortalAuth from '../components/shared/PortalAuth.jsx';
import PortalBackBar from '../components/shared/PortalBackBar.jsx';
import CountApp from '../count/CountApp.jsx';
import '../count/count.css';

export default function CountPage() {
    return (
        <>
            <PortalBackBar backLabel="← FLOOR" />
            <div className="count-portal-host pulse-bridge" data-pulse-surface="rec">
                <main id="main" className="count-main">
                <CountApp
                    renderAuthWrapper={(app) => (
                        <PortalAuth
                            title="INVENTORY COUNT"
                            buttonLabel="ENTER SYSTEM"
                            backLabel="← Back to TGP Center Store"
                        >
                            {app}
                        </PortalAuth>
                    )}
                />
                </main>
            </div>
        </>
    );
}
