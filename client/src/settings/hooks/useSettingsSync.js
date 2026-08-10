import { useCallback, useEffect, useRef, useState } from 'react';
import { getSync } from '../../lib/api.js';
import { usePortalStream } from '../../lib/usePortalStream.js';
import { fetchScheduleHealth } from '../lib/settingsApi.js';

export function useSettingsSync({ token, enabled = true }) {
    const [syncData, setSyncData] = useState(null);
    const [scheduleHealth, setScheduleHealth] = useState(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState('');
    const refreshSeqRef = useRef(0);
    const streamDebounceRef = useRef(null);

    const refresh = useCallback(async () => {
        if (!token || !enabled) return null;
        const seq = ++refreshSeqRef.current;
        setLoading(true);
        try {
            const data = await getSync(token);
            if (seq !== refreshSeqRef.current) return null;
            setSyncData(data);
            setError('');
            return data;
        } catch (e) {
            if (seq !== refreshSeqRef.current) return null;
            setError(e.message || 'Sync failed');
            throw e;
        } finally {
            if (seq === refreshSeqRef.current) setLoading(false);
        }
    }, [token, enabled]);

    const refreshScheduleHealth = useCallback(async () => {
        if (!token || !enabled) return null;
        try {
            const health = await fetchScheduleHealth(token);
            setScheduleHealth(health);
            return health;
        } catch (e) {
            setScheduleHealth(null);
            throw e;
        }
    }, [token, enabled]);

    useEffect(() => {
        if (!token || !enabled) return;
        refresh().catch(() => {});
    }, [token, enabled, refresh]);

    useEffect(() => () => {
        if (streamDebounceRef.current) clearTimeout(streamDebounceRef.current);
    }, [refresh]);

    const onStreamEvent = useCallback(() => {
        if (streamDebounceRef.current) clearTimeout(streamDebounceRef.current);
        streamDebounceRef.current = setTimeout(() => {
            streamDebounceRef.current = null;
            refresh().catch(() => {});
        }, 250);
    }, [refresh]);

    usePortalStream({
        token: enabled ? token : '',
        onEvent: onStreamEvent,
    });

    return {
        syncData,
        setSyncData,
        scheduleHealth,
        setScheduleHealth,
        loading,
        error,
        refresh,
        refreshScheduleHealth,
    };
}
