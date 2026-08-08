import { useEffect, useState } from 'react';
import { useAuth } from '../../lib/auth.jsx';
import { useSync } from '../../providers/SyncProvider.jsx';
import { bootPulsePrefs } from '../../lib/pulsePrefs.js';
import usePulseI18n from '../../hooks/usePulseI18n.js';
import KpiBar from './KpiBar.jsx';
import OosList from './OosList.jsx';
import TaskList from './TaskList.jsx';
import DailyDirectionBanner from './DailyDirectionBanner.jsx';
import SafetyFocusBanner from './SafetyFocusBanner.jsx';
import LiveTicker from './LiveTicker.jsx';
import KillDatesList from './KillDatesList.jsx';
import CustomerOrdersList from './CustomerOrdersList.jsx';
import VendorDeliveriesList from './VendorDeliveriesList.jsx';
import HardwareOrdersList from './HardwareOrdersList.jsx';
import RecentActivityList from './RecentActivityList.jsx';
import FloorSidebar from './sidebar/FloorSidebar.jsx';
import ManagerBanner from './ManagerBanner.jsx';
import AlertZone from './AlertZone.jsx';
import CommsFeedPanel from './CommsFeedPanel.jsx';
import HomeBaseDashboard from './HomeBaseDashboard.jsx';
import RecvDockList from './RecvDockList.jsx';
import ReceivingTools from './ReceivingTools.jsx';
import MorningRhythmBanner from './MorningRhythmBanner.jsx';
import RestartRequiredBanner from './RestartRequiredBanner.jsx';
import { useFloorRole } from '../../hooks/useFloorRole.js';

function ConnStatus({ connected }) {
    const { t } = usePulseI18n();
    return (
        <div style={{ display: 'flex', alignItems: 'center' }}>
            <div
                id="conn-dot"
                style={{
                    width: 10,
                    height: 10,
                    borderRadius: '50%',
                    background: connected ? '#00ff00' : '#ff4444',
                    boxShadow: connected ? '0 0 8px #00ff00' : '0 0 8px #ff4444',
                    marginRight: 10,
                }}
            />
            <div id="conn-text" className="conn-status-text" style={{ letterSpacing: '3px', fontWeight: 300 }}>
                {connected ? t('sys_ok') : t('sys_offline')}
            </div>
        </div>
    );
}

export default function FloorApp() {
    const { user, logout } = useAuth();
    const { connected } = useSync();
    const { isManager, isPremium } = useFloorRole();
    const [liveTime, setLiveTime] = useState(() => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
    const [showHomeBase, setShowHomeBase] = useState(false);

    useEffect(() => {
        bootPulsePrefs();
    }, []);

    useEffect(() => {
        const id = setInterval(() => {
            setLiveTime(new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
        }, 1000);
        return () => clearInterval(id);
    }, []);

    const handleRelease = async () => {
        if (!window.confirm('Log out of this device?')) return;
        logout();
        localStorage.clear();
        sessionStorage.clear();
        window.location.reload();
    };

    return (
        <div className="streamlit-wrapper" id="app-screen">
            <aside className="st-sidebar">
                <div className="floor-sidebar-header" style={{
                    display: 'flex', alignItems: 'center', padding: 20,
                    justifyContent: 'space-between', borderBottom: '1px solid var(--prism-border)', marginBottom: 20,
                }}
                >
                    <ConnStatus connected={connected} />
                    <button
                        type="button"
                        className="st-btn"
                        style={{ width: 'auto', padding: '5px 10px', fontSize: '0.7em', borderColor: '#f33', color: '#f33' }}
                        onClick={handleRelease}
                    >
                        RELEASE
                    </button>
                </div>

                <div className="floor-user-line" style={{ padding: '0 20px 10px 20px', fontSize: '0.85em' }}>
                    Logged in as: <strong id="display-user" className="floor-user-name">{user}</strong>
                </div>

                <FloorSidebar onOpenMap={() => setShowHomeBase(true)} />
            </aside>

            <main className="st-main">
                <div className="main-pad">
                    <ManagerBanner />
                    <AlertZone />

                    {showHomeBase ? (
                        <HomeBaseDashboard onClose={() => setShowHomeBase(false)} />
                    ) : null}

                    <div className="header-bar">
                        <div className="header-title">TGP CENTRE STORE</div>
                        <div className="header-time" id="live-time">{liveTime}</div>
                    </div>

                    <KpiBar />
                    {(isManager || isPremium) ? <RestartRequiredBanner /> : null}
                    <MorningRhythmBanner />
                    <LiveTicker />

                    <div className="split-layout">
                        <div className="col-left">
                            <div className="floor-plan-stack">
                                <DailyDirectionBanner />
                                <SafetyFocusBanner />
                                <CommsFeedPanel />
                            </div>

                            <div className="sect-header">TASKS</div>
                            <div id="task-list" className="floor-task-scroll">
                                <TaskList />
                            </div>
                        </div>

                        <div className="col-right">
                            <div className="sect-header">INVENTORY FLAGS (OOS)</div>
                            <div id="oos-list">
                                <OosList />
                            </div>

                            <div className="sect-header" style={{ marginTop: 20 }}>EXPIRY PULL / WARN</div>
                            <div id="kill-dates-list">
                                <KillDatesList />
                            </div>

                            <div className="sect-header" style={{ marginTop: 20 }}>CUSTOMER ORDERS</div>
                            <div id="order-list">
                                <CustomerOrdersList />
                            </div>

                            <div className="sect-header" style={{ marginTop: 20 }}>VENDOR DELIVERIES</div>
                            <div id="vendor-list">
                                <VendorDeliveriesList />
                            </div>

                            <div className="sect-header" style={{ marginTop: 20 }}>HARDWARE ORDERS</div>
                            <div id="hardware-order-list">
                                <HardwareOrdersList />
                            </div>

                            <RecvDockList />
                            <ReceivingTools />

                            <div className="sect-header recent-activity-header" style={{ marginTop: 20 }}>RECENT ACTIVITY</div>
                            <div id="recent-activity-list">
                                <RecentActivityList />
                            </div>
                        </div>
                    </div>
                </div>
            </main>
        </div>
    );
}
