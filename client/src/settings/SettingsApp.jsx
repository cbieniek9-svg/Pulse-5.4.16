import { lazy, Suspense, useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth.jsx';
import PortalBackBar from '../components/shared/PortalBackBar.jsx';
import { SettingsProvider, useSettings } from './context/SettingsContext.jsx';
import { TAB_LABELS, VALID_TABS, tabFromLocation } from './lib/settingsHelpers.js';
import RhythmTab from './tabs/RhythmTab.jsx';
import './settings.css';

const VendorsTab = lazy(() => import('./tabs/VendorsTab.jsx'));
const DeliveriesTab = lazy(() => import('./tabs/DeliveriesTab.jsx'));
const StoreTvTab = lazy(() => import('./tabs/StoreTvTab.jsx'));
const SafetyTab = lazy(() => import('./tabs/SafetyTab.jsx'));
const StaffTab = lazy(() => import('./tabs/StaffTab.jsx'));
const ItemsCatalogTab = lazy(() => import('./tabs/ItemsCatalogTab.jsx'));
const TaskTimesTab = lazy(() => import('./tabs/TaskTimesTab.jsx'));
const DevicesTab = lazy(() => import('./tabs/DevicesTab.jsx'));
const MaintenanceTab = lazy(() => import('./tabs/MaintenanceTab.jsx'));

const TAB_COMPONENTS = {
    rhythm: RhythmTab,
    vendors: VendorsTab,
    deliveries: DeliveriesTab,
    store: StoreTvTab,
    safety: SafetyTab,
    staff: StaffTab,
    items: ItemsCatalogTab,
    audit: TaskTimesTab,
    devices: DevicesTab,
    maintenance: MaintenanceTab,
};

function TabFallback() {
    return (
        <div
            className="mgr-card"
            style={{ color: '#8cf', textAlign: 'center', padding: 24, minHeight: 320 }}
            aria-busy="true"
        >
            Loading tab…
        </div>
    );
}

function SettingsShell() {
    const { user, refresh, loading } = useSettings();
    const location = useLocation();
    const navigate = useNavigate();
    const activeTab = tabFromLocation(location.search, location.hash);
    const mainRef = useRef(null);
    const tabsRef = useRef(null);

    const switchTab = useCallback((name) => {
        const tab = VALID_TABS.includes(name) ? name : 'rhythm';
        const params = new URLSearchParams(location.search);
        params.set('tab', tab);
        navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
    }, [location.pathname, location.search, navigate]);

    useEffect(() => {
        const onFocus = () => { refresh(); };
        window.addEventListener('focus', onFocus);
        return () => window.removeEventListener('focus', onFocus);
    }, [refresh]);

    // Reset panel scroll and keep the active tab chip visible.
    useEffect(() => {
        if (mainRef.current) mainRef.current.scrollTop = 0;
        const activeBtn = tabsRef.current?.querySelector('.mgr-tab.active');
        activeBtn?.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    }, [activeTab]);

    const ActivePanel = TAB_COMPONENTS[activeTab] || RhythmTab;

    return (
        <div id="app" className="mgr-settings-app mgr-settings-body pulse-bridge" data-pulse-surface="mgr">
            <PortalBackBar backLabel="← FLOOR" />
            <header className="mgr-hdr">
                <div>
                    <div className="mgr-hdr-title">SETTINGS</div>
                    <div className="mgr-hdr-sub">
                        {TAB_LABELS[activeTab] || 'Editor'}
                        {user ? ` · ${user}` : ''}
                    </div>
                </div>
                <div className="mgr-hdr-actions">
                    <button
                        type="button"
                        className="st-btn"
                        style={{ width: 'auto', padding: '6px 14px', fontSize: '0.75em' }}
                        onClick={refresh}
                        disabled={loading}
                    >
                        {loading ? '…' : '↻ REFRESH'}
                    </button>
                </div>
            </header>

            <nav className="mgr-tabs" role="tablist" ref={tabsRef} aria-label="Settings sections">
                {VALID_TABS.map((tab) => (
                    <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={activeTab === tab}
                        className={`mgr-tab${activeTab === tab ? ' active' : ''}`}
                        data-tab={tab}
                        onClick={() => switchTab(tab)}
                    >
                        {TAB_LABELS[tab]}
                    </button>
                ))}
            </nav>

            <main id="main" className="mgr-page mgr-settings-scroll" ref={mainRef}>
                <section id={`panel-${activeTab}`} className="mgr-panel active">
                    {activeTab === 'rhythm' ? (
                        <ActivePanel />
                    ) : (
                        <Suspense fallback={<TabFallback />}>
                            <ActivePanel />
                        </Suspense>
                    )}
                </section>
            </main>
        </div>
    );
}

export default function SettingsApp() {
    const { user } = useAuth();

    return (
        <SettingsProvider key={user}>
            <SettingsShell />
        </SettingsProvider>
    );
}
