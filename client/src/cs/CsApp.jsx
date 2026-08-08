import { useCsPortal } from './useCsPortal.js';
import { VIEWS } from './csConstants.js';
import { CsLoginView } from './CsLoginView.jsx';
import { CsLegacyView } from './CsLegacyView.jsx';
import { CsFullView } from './CsFullView.jsx';
import { CsDueBoardView } from './CsDueBoardView.jsx';
import { CsCustomersView } from './CsCustomersView.jsx';
import { CsCustomerProfileView } from './CsCustomerProfileView.jsx';
import { CsHubView } from './CsHubView.jsx';
import './cs.css';

export default function CsApp() {
    const {
        view,
        portalCfg,
        bootError,
        user,
        token,
        overdueCount,
        profileId,
        csFullOpts,
        modeClass,
        handleLoginSuccess,
        handleLogout,
        navigate,
        goHub,
        openCsFull,
    } = useCsPortal();

    let content;
    if (bootError) {
        content = <div className="loading status-copy error">{bootError}</div>;
    } else if (view === VIEWS.LOADING) {
        content = <div className="loading">LOADING CS PORTAL…</div>;
    } else if (view === VIEWS.LOGIN) {
        content = <CsLoginView onSuccess={handleLoginSuccess} />;
    } else if (view === VIEWS.HUB) {
        content = (
            <CsHubView
                portalCfg={portalCfg}
                user={user}
                overdueCount={overdueCount}
                onNavigate={navigate}
                onLogout={handleLogout}
            />
        );
    } else if (view === VIEWS.LEGACY) {
        content = (
            <CsLegacyView
                portalCfg={portalCfg}
                user={user}
                token={token}
                onBackHub={portalCfg.hub ? goHub : undefined}
            />
        );
    } else if (view === VIEWS.CS_FULL) {
        content = (
            <CsFullView
                portalCfg={portalCfg}
                user={user}
                token={token}
                fromHub={csFullOpts.fromHub}
                prefill={csFullOpts.prefill}
                onBackHub={goHub}
                onOpenProfile={(id) => navigate(VIEWS.PROFILE, { customerId: id })}
            />
        );
    } else if (view === VIEWS.DUE) {
        content = (
            <CsDueBoardView
                user={user}
                token={token}
                onBackHub={goHub}
                onOpenFull={() => openCsFull({ fromHub: true })}
            />
        );
    } else if (view === VIEWS.CUSTOMERS) {
        content = (
            <CsCustomersView
                user={user}
                token={token}
                onBackHub={goHub}
                onOpenProfile={(id) => navigate(VIEWS.PROFILE, { customerId: id })}
            />
        );
    } else if (view === VIEWS.PROFILE) {
        content = (
            <CsCustomerProfileView
                user={user}
                token={token}
                customerId={profileId}
                onBackCustomers={() => navigate(VIEWS.CUSTOMERS)}
                onBackHub={goHub}
                onNewOrder={(prefill) => openCsFull({ fromHub: true, prefill })}
            />
        );
    }

    return (
        <div className={'cs-portal-root ' + modeClass}>
            <main id="main" className="cs-main">
                <div id="mode-root">{content}</div>
            </main>
        </div>
    );
}
