import { Link } from 'react-router-dom';
import { useFloorRole } from '../../../hooks/useFloorRole.js';
import ProfileSettingsPanel from './ProfileSettingsPanel.jsx';
import OperationsLoggingPanel from './OperationsLoggingPanel.jsx';
import LaborInventoryPanel from './LaborInventoryPanel.jsx';
import ShiftRosterPanel from './ShiftRosterPanel.jsx';
import Core4ZoneCheckPanel from './Core4ZoneCheckPanel.jsx';
import MessageCenterPanel from './MessageCenterPanel.jsx';
import ManagementHub from './ManagementHub.jsx';

export default function FloorSidebar({ onOpenMap }) {
    const {
        showOpsLogging, showReceiving, showMarkdown, showComms, showPremOnly, showMgrOnly,
    } = useFloorRole();

    return (
        <div className="sidebar-pad">
            <details className="st-expander">
                <summary className="st-expander-header">👤 My Profile Settings</summary>
                <div className="st-expander-content">
                    <ProfileSettingsPanel />
                </div>
            </details>

            {showOpsLogging ? (
                <details className="st-expander perm-markdown">
                    <summary className="st-expander-header">🛠️ OPERATIONS LOGGING</summary>
                    <div className="st-expander-content">
                        <OperationsLoggingPanel />
                    </div>
                </details>
            ) : null}

            {showReceiving ? (
                <details className="st-expander perm-receiving">
                    <summary className="st-expander-header">📊 LABOR & INVENTORY</summary>
                    <div className="st-expander-content">
                        <LaborInventoryPanel />
                    </div>
                </details>
            ) : null}

            {showPremOnly ? (
                <details className="st-expander prem-only">
                    <summary className="st-expander-header">👥 SHIFT ROSTER</summary>
                    <div className="st-expander-content">
                        <ShiftRosterPanel />
                    </div>
                </details>
            ) : null}

            {showPremOnly ? (
                <details className="st-expander prem-only">
                    <summary className="st-expander-header">✅ CORE 4 ZONE CHECK</summary>
                    <div className="st-expander-content">
                        <Core4ZoneCheckPanel />
                    </div>
                </details>
            ) : null}

            {showComms ? (
                <details className="st-expander perm-comms">
                    <summary className="st-expander-header">📣 MESSAGE CENTER</summary>
                    <div className="st-expander-content">
                        <MessageCenterPanel />
                    </div>
                </details>
            ) : null}

            {showMgrOnly ? <ManagementHub onOpenMap={onOpenMap} /> : null}

            {(showReceiving || showMarkdown || showMgrOnly) ? (
                <nav style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 20 }}>
                    {showReceiving ? (
                        <Link to="/rec" className="st-btn" style={{ textAlign: 'center', textDecoration: 'none', borderColor: '#f90', color: '#f90' }}>RECEIVING</Link>
                    ) : null}
                    {showMarkdown ? (
                        <Link to="/markdown" className="st-btn" style={{ textAlign: 'center', textDecoration: 'none', borderColor: '#a855f7', color: '#c9a0ff' }}>MARKDOWN SCAN</Link>
                    ) : null}
                    <Link to="/count" className="st-btn" style={{ textAlign: 'center', textDecoration: 'none', borderColor: '#0f8', color: '#0f8', fontWeight: 700 }}>COUNT</Link>
                </nav>
            ) : null}
        </div>
    );
}
