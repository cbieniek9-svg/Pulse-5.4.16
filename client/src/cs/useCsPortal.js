import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
    clearCsSession,
    crmOn,
    csFullOn,
    getCsSession,
    getDueOrders,
    getPortalConfig,
} from './csApi.js';
import { VIEWS } from './csConstants.js';

/**
 * CS portal boot, session, and view navigation.
 */
export function useCsPortal() {
    const [view, setView] = useState(VIEWS.LOADING);
    const [portalCfg, setPortalCfg] = useState({ hub: false, csFull: false, crm: false, betacs: false });
    const [bootError, setBootError] = useState('');
    const [user, setUser] = useState(() => getCsSession().user);
    const [token, setToken] = useState(() => getCsSession().token);
    const [overdueCount, setOverdueCount] = useState(0);
    const [profileId, setProfileId] = useState('');
    const [csFullOpts, setCsFullOpts] = useState({ fromHub: false, prefill: null });
    const viewRef = useRef(view);
    viewRef.current = view;

    const refreshDueAlert = useCallback(async (cfg) => {
        if (!csFullOn(cfg)) {
            setOverdueCount(0);
            return 0;
        }
        try {
            const data = await getDueOrders();
            const count = Number(data.overdueCount || 0);
            setOverdueCount(count);
            return count;
        } catch {
            return 0;
        }
    }, []);

    const boot = useCallback(async () => {
        setBootError('');
        setView(VIEWS.LOADING);
        try {
            const cfg = await getPortalConfig();
            setPortalCfg(cfg);
            const session = getCsSession();
            setUser(session.user);
            setToken(session.token);
            if (cfg.hub) {
                if (session.token && session.user) {
                    await refreshDueAlert(cfg);
                    setView(VIEWS.HUB);
                } else {
                    setOverdueCount(0);
                    setView(VIEWS.LOGIN);
                }
            } else if (csFullOn(cfg)) {
                // Beta CS_Full requires a staff session (CRM / board / print).
                // Legacy desk orders use either that session or the paired CS device token.
                if (session.token && session.user) {
                    await refreshDueAlert(cfg);
                    setCsFullOpts({ fromHub: false, prefill: null });
                    setView(VIEWS.CS_FULL);
                } else {
                    setOverdueCount(0);
                    setView(VIEWS.LOGIN);
                }
            } else {
                setView(VIEWS.LEGACY);
            }
        } catch (err) {
            setBootError(err.message || 'Could not load portal config.');
            setView(VIEWS.LOADING);
        }
    }, [refreshDueAlert]);

    useEffect(() => { boot(); }, [boot]);

    useEffect(() => {
        const onVisible = () => {
            if (document.visibilityState !== 'visible') return;
            getPortalConfig()
                .then((cfg) => {
                    const currentView = viewRef.current;
                    const hubViews = [VIEWS.LOGIN, VIEWS.HUB, VIEWS.DUE, VIEWS.CUSTOMERS, VIEWS.PROFILE];
                    const fullViews = [VIEWS.CS_FULL];
                    const legacyOnly = currentView === VIEWS.LEGACY;
                    if (cfg.hub !== portalCfg.hub
                        || csFullOn(cfg) !== csFullOn(portalCfg)
                        || crmOn(cfg) !== crmOn(portalCfg)
                        || (cfg.hub && !hubViews.includes(currentView) && !fullViews.includes(currentView) && !legacyOnly)) {
                        window.location.reload();
                    } else {
                        setPortalCfg(cfg);
                    }
                })
                .catch(() => {});
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => document.removeEventListener('visibilitychange', onVisible);
    }, [portalCfg]);

    const handleLoginSuccess = (name, tok) => {
        setUser(name);
        setToken(tok);
        refreshDueAlert(portalCfg);
        if (portalCfg.hub) setView(VIEWS.HUB);
        else if (csFullOn(portalCfg)) {
            setCsFullOpts({ fromHub: false, prefill: null });
            setView(VIEWS.CS_FULL);
        } else {
            setView(VIEWS.HUB);
        }
    };

    const handleLogout = () => {
        clearCsSession();
        setUser('');
        setToken('');
        setView(VIEWS.LOGIN);
    };

    const navigate = useCallback((nextView, opts = {}) => {
        if (nextView === VIEWS.CS_FULL) {
            setCsFullOpts({ fromHub: !!opts.fromHub, prefill: opts.prefill || null });
        }
        if (nextView === VIEWS.PROFILE && opts.customerId) {
            setProfileId(opts.customerId);
        }
        setView(nextView);
    }, []);

    const goHub = () => {
        refreshDueAlert(portalCfg);
        setView(VIEWS.HUB);
    };

    const openCsFull = (opts = {}) => {
        navigate(VIEWS.CS_FULL, opts);
    };

    const modeClass = useMemo(() => {
        if (view === VIEWS.LOGIN || view === VIEWS.LEGACY) return 'legacy-mode';
        if (view === VIEWS.CS_FULL) return 'cs-full-mode betacs-mode';
        if ([VIEWS.HUB, VIEWS.DUE, VIEWS.CUSTOMERS, VIEWS.PROFILE].includes(view)) return 'hub-mode';
        return 'legacy-mode';
    }, [view]);

    return {
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
    };
}
