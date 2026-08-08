import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import FloorLayout from './layouts/FloorLayout.jsx';
import FloorPage from './pages/FloorPage.jsx';
import RecPage from './pages/RecPage.jsx';
import MarkdownPage from './pages/MarkdownPage.jsx';
import CsPage from './pages/CsPage.jsx';
import SafePage from './pages/SafePage.jsx';
import CountPage from './pages/CountPage.jsx';
import LogPage from './pages/LogPage.jsx';
import ReportsPage from './pages/ReportsPage.jsx';

const SettingsPage = lazy(() => import('./pages/SettingsPage.jsx'));

/** Settings-shaped shell so lazy chunk swap does not shove main around. */
function SettingsRouteFallback() {
    return (
        <div
            id="app"
            className="mgr-settings-app mgr-settings-body pulse-bridge"
            data-pulse-surface="mgr"
            aria-busy="true"
            style={{ height: '100vh', maxHeight: '100vh', width: '100%', overflow: 'hidden', display: 'flex', flexDirection: 'column', background: '#0a1525', boxSizing: 'border-box' }}
        >
            <div className="portal-back-bar" style={{ flex: '0 0 45px', height: 45, boxSizing: 'border-box' }} aria-hidden="true" />
            <header className="mgr-hdr" style={{ flex: '0 0 auto', minHeight: 72, position: 'relative' }}>
                <div>
                    <div className="mgr-hdr-title">⚙️ SETTINGS EDITOR</div>
                    <div className="mgr-hdr-sub">Rhythms · vendors · deliveries · store/TV · staff · task audit</div>
                </div>
                <div className="mgr-hdr-actions" style={{ minWidth: 420, minHeight: 32 }} />
            </header>
            <nav className="mgr-tabs" style={{ flex: '0 0 56px', height: 56, minHeight: 56, flexWrap: 'nowrap', overflowX: 'auto', position: 'relative' }} aria-hidden="true" />
            <main
                id="main"
                className="mgr-page mgr-settings-scroll"
                style={{ flex: 1, minHeight: 0, minWidth: 0, width: '100%', maxWidth: 'none', alignSelf: 'stretch', overflow: 'auto', boxSizing: 'border-box' }}
            >
                <div className="mgr-section-title">DAILY RHYTHM TEMPLATE</div>
                <div className="mgr-card" style={{ minHeight: 220 }} aria-hidden="true" />
                <div className="mgr-table-wrap" style={{ height: 560, minHeight: 560, maxHeight: 560, overflow: 'auto' }}>
                    <div style={{ color: '#8cf', textAlign: 'center', padding: 24 }}>Loading rhythm tasks…</div>
                </div>
            </main>
        </div>
    );
}

export default function App() {
    return (
        <BrowserRouter>
            <Routes>
                <Route element={<FloorLayout />}>
                    <Route index element={<FloorPage />} />
                </Route>
                <Route path="/reports" element={<ReportsPage />} />
                <Route path="/settings" element={<Suspense fallback={<SettingsRouteFallback />}><SettingsPage /></Suspense>} />
                <Route path="/rec" element={<RecPage />} />
                <Route path="/financial" element={<LogPage />} />
                <Route path="/log" element={<Navigate to="/financial" replace />} />
                <Route path="/markdown" element={<MarkdownPage />} />
                <Route path="/cs" element={<CsPage />} />
                <Route path="/betacs" element={<Navigate to="/cs" replace />} />
                <Route path="/safe" element={<SafePage />} />
                <Route path="/saafe" element={<Navigate to="/safe" replace />} />
                <Route path="/count" element={<CountPage />} />
                <Route path="*" element={<Navigate to="/" replace />} />
            </Routes>
        </BrowserRouter>
    );
}
