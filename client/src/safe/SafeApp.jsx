import { useState } from 'react';
import { useAuth } from '../lib/auth.jsx';
import HomeScreen from './components/HomeScreen.jsx';
import InspectScreen from './components/InspectScreen.jsx';
import InvestigateWizard from './components/InvestigateWizard.jsx';

export default function SafeApp() {
    const { token, user } = useAuth();
    const [view, setView] = useState('home');
    const [homeTab, setHomeTab] = useState('inspections');
    const [inspectTarget, setInspectTarget] = useState(null);
    const [investigateTarget, setInvestigateTarget] = useState(null);
    const [homeRefreshKey, setHomeRefreshKey] = useState(0);

    const openInspection = (target) => {
        setInspectTarget(target);
        setView('inspect');
    };

    const openInvestigation = (target) => {
        setInvestigateTarget(target);
        setView('investigate');
    };

    const backHome = (tab = homeTab) => {
        setView('home');
        setHomeTab(tab);
        setInspectTarget(null);
        setInvestigateTarget(null);
        setHomeRefreshKey((k) => k + 1);
    };

    return (
        <main id="main" className="safe-portal" data-pulse-surface="safe">
            {view === 'home' ? (
                <HomeScreen
                    key={homeRefreshKey}
                    token={token}
                    user={user}
                    homeTab={homeTab}
                    onTabChange={setHomeTab}
                    onOpenInspection={openInspection}
                    onOpenInvestigation={openInvestigation}
                />
            ) : null}
            {view === 'inspect' ? (
                <InspectScreen
                    token={token}
                    runIdOrPayload={inspectTarget}
                    onBack={() => backHome('inspections')}
                />
            ) : null}
            {view === 'investigate' ? (
                <InvestigateWizard
                    token={token}
                    idOrPayload={investigateTarget}
                    onBack={backHome}
                />
            ) : null}
        </main>
    );
}
