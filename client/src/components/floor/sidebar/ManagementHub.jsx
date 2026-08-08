import { Link } from 'react-router-dom';
import FinancialLogLink from '../../../log/FinancialLogLink.jsx';
import DailyDirectionPanel from '../hub/DailyDirectionPanel.jsx';
import BriefingPanel from '../hub/BriefingPanel.jsx';
import ExpiryMarkdownPanel from '../hub/ExpiryMarkdownPanel.jsx';
import PresencePanel from '../hub/PresencePanel.jsx';
import HomeBaseAuditsPanel from '../hub/HomeBaseAuditsPanel.jsx';
import SystemAdminPanel from '../hub/SystemAdminPanel.jsx';

export default function ManagementHub({ onOpenMap }) {
    return (
        <details className="st-expander mgr-only">
            <summary className="st-expander-header" onClick={() => onOpenMap?.(true)}>👔 MANAGEMENT HUB</summary>
            <div className="st-expander-content">
                <div style={{ marginBottom: 12, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center' }}>
                    <Link to="/reports" style={{ display: 'inline-block', border: '1px solid #0cf', color: '#0cf', padding: '8px 20px', borderRadius: 20, fontSize: '0.8em', letterSpacing: 2, textDecoration: 'none' }}>📊 OPEN REPORTS DASHBOARD</Link>
                    <FinancialLogLink />
                    <Link to="/markdown" style={{ display: 'inline-block', border: '1px solid #a855f7', color: '#c9a0ff', padding: '8px 20px', borderRadius: 20, fontSize: '0.8em', letterSpacing: 2, textDecoration: 'none' }}>📋 MARKDOWN FIFO SCAN</Link>
                    <Link to="/count" style={{ display: 'inline-block', border: '1px solid #0f8', color: '#0f8', padding: '8px 20px', borderRadius: 20, fontSize: '0.8em', letterSpacing: 2, textDecoration: 'none', fontWeight: 700 }}>📦 COUNT</Link>
                    <Link to="/settings" style={{ display: 'inline-block', border: '1px solid #00e5ff', color: '#00e5ff', padding: '8px 20px', borderRadius: 20, fontSize: '0.8em', letterSpacing: 2, textDecoration: 'none' }}>⚙️ SETTINGS EDITOR</Link>
                </div>

                <details className="st-expander" style={{ border: 'none', background: 'none', marginBottom: 15 }}>
                    <summary style={{ color: '#0f8', fontSize: '0.9em', cursor: 'pointer', marginBottom: 10 }}>🧭 DAILY DIRECTION</summary>
                    <div style={{ background: 'rgba(0,255,136,0.06)', padding: 10, borderRadius: 4, border: '1px solid rgba(0,255,136,0.25)' }}>
                        <DailyDirectionPanel />
                    </div>
                </details>

                <details className="st-expander" style={{ border: 'none', background: 'none', marginBottom: 15 }}>
                    <summary style={{ color: '#f90', fontSize: '0.85em', cursor: 'pointer', marginBottom: 10 }}>📋 TODAY&apos;S BRIEFING</summary>
                    <div style={{ background: 'rgba(255,80,0,0.06)', padding: 10, borderRadius: 4, border: '1px solid rgba(255,136,0,0.2)' }}>
                        <BriefingPanel />
                    </div>
                </details>

                <details className="st-expander" style={{ border: 'none', background: 'none', marginBottom: 15 }}>
                    <summary style={{ color: '#8cf', fontSize: '0.85em', cursor: 'pointer', marginBottom: 10 }}>📅 EXPIRY / MARKDOWN (LIVE BOARD)</summary>
                    <div style={{ background: 'rgba(0,0,0,0.2)', padding: 10, borderRadius: 4 }}>
                        <ExpiryMarkdownPanel />
                    </div>
                </details>

                <details className="st-expander" style={{ border: 'none', background: 'none', marginBottom: 15 }}>
                    <summary style={{ color: '#0cf', fontSize: '0.85em', cursor: 'pointer', marginBottom: 10 }}>📡 BLE PRESENCE (OPTIONAL)</summary>
                    <div style={{ background: 'rgba(0,229,255,0.06)', padding: 10, borderRadius: 4, border: '1px solid rgba(0,229,255,0.25)' }}>
                        <PresencePanel />
                    </div>
                </details>

                <details className="st-expander" style={{ border: 'none', background: 'none', marginBottom: 15 }}>
                    <summary style={{ color: '#8cf', fontSize: '0.85em', cursor: 'pointer', marginBottom: 10 }}>🏠 HOME BASE AUDITS</summary>
                    <div style={{ background: 'rgba(0,0,0,0.2)', padding: 10, borderRadius: 4 }}>
                        <HomeBaseAuditsPanel />
                    </div>
                </details>

                <details className="st-expander" style={{ border: 'none', background: 'none', marginBottom: 15 }}>
                    <summary style={{ color: '#8cf', fontSize: '0.85em', cursor: 'pointer', marginBottom: 10 }}>⚙️ SYSTEM ADMIN</summary>
                    <SystemAdminPanel />
                </details>
            </div>
        </details>
    );
}
