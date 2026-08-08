import { crmOn, csFullOn } from './csApi.js';
import { VIEWS } from './csConstants.js';

function CsHubView({ portalCfg, user, overdueCount, onNavigate, onLogout }) {
    const full = csFullOn(portalCfg);
    const crm = crmOn(portalCfg);

    return (
        <div className="wrap">
            <div className="hub-user">
                {user} · <button type="button" className="st-btn ghost sm" onClick={onLogout}>LOGOUT</button>
            </div>
            <div className="cs-title">CS MODULE</div>
            {overdueCount > 0 ? (
                <div className="hub-alert">
                    {overdueCount} OVERDUE PICKUP{overdueCount === 1 ? '' : 'S'}
                </div>
            ) : null}
            <div className="hub-grid">
                {crm ? (
                    <button type="button" className="hub-btn" data-testid="hub-customers" onClick={() => onNavigate(VIEWS.CUSTOMERS)}>
                        Customers
                        <small>Find by phone / name · history · notes</small>
                    </button>
                ) : null}
                <button type="button" className="hub-btn" data-testid="hub-legacy" onClick={() => onNavigate(VIEWS.LEGACY)}>
                    Log customer order
                    <small>Legacy quick TV form (optional — CS_Full is the binder)</small>
                </button>
                <button type="button" className="hub-btn" data-testid="hub-cs-full" disabled={!full} onClick={() => full && onNavigate(VIEWS.CS_FULL, { fromHub: true })}>
                    CS_Full
                    <small>{full ? 'Full order log + board by department' : 'Enable CS_Full in manager settings'}</small>
                </button>
                <button type="button" className="hub-btn" data-testid="hub-due" disabled={!full} onClick={() => full && onNavigate(VIEWS.DUE)}>
                    Due / pickups
                    <small>{full ? (overdueCount ? `${overdueCount} overdue` : 'Check & clear picked-up orders') : 'Requires CS_Full'}</small>
                </button>
            </div>
            <p className="hint">
                {crm
                    ? 'CRM is on — use Customers for walk-in lookup. Floor still clears Ready pickups on mobile.'
                    : 'Floor staff clear Ready pickups on mobile (PICKED UP). Enable CS customer CRM in manager settings when ready.'}
            </p>
        </div>
    );
}


export { CsHubView };
