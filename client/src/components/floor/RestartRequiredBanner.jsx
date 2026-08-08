import { useCallback, useEffect, useState } from 'react';
import { getReady } from '../../lib/api.js';

const POLL_MS = 60_000;

/**
 * Surfaces /api/ready restart_required when dist/ui or app-version on disk
 * is newer than the running process (common after build:ui without service restart).
 * Role gating is the caller's job (floor: manager/premium; settings: already manager-only).
 */
export default function RestartRequiredBanner({ compact = false } = {}) {
    const [report, setReport] = useState(null);
    const [copied, setCopied] = useState(false);

    const refresh = useCallback(async () => {
        try {
            const ready = await getReady();
            setReport(ready);
        } catch (_) {
            /* offline — leave last known */
        }
    }, []);

    useEffect(() => {
        refresh();
        const id = setInterval(refresh, POLL_MS);
        const onVisible = () => {
            if (document.visibilityState === 'visible') refresh();
        };
        document.addEventListener('visibilitychange', onVisible);
        window.addEventListener('focus', onVisible);
        return () => {
            clearInterval(id);
            document.removeEventListener('visibilitychange', onVisible);
            window.removeEventListener('focus', onVisible);
        };
    }, [refresh]);

    if (!report?.restart_required) return null;

    const summary = report.deploy?.summary
        || 'On-disk UI/version is newer than the running process.';
    const cmd = 'Restart-Service TGP-CommandCenter';

    const copyCmd = async () => {
        try {
            await navigator.clipboard.writeText(cmd);
            setCopied(true);
            setTimeout(() => setCopied(false), 2500);
        } catch (_) {
            setCopied(false);
        }
    };

    return (
        <div
            role="status"
            style={{
                position: 'fixed',
                top: 12,
                left: '50%',
                transform: 'translateX(-50%)',
                zIndex: 100001,
                width: 'min(640px, calc(100vw - 24px))',
                marginBottom: 0,
                padding: compact ? '10px 12px' : '12px 14px',
                borderRadius: 6,
                border: '1px solid #f90',
                background: 'rgba(20, 14, 0, 0.96)',
                color: '#eef5ff',
                boxShadow: '0 12px 40px rgba(0,0,0,0.45)',
            }}
        >
            <div style={{ fontWeight: 700, letterSpacing: 1, color: '#f90', fontSize: '0.8em', marginBottom: 6 }}>
                RESTART REQUIRED
            </div>
            <div style={{ fontSize: '0.85em', textTransform: 'none', lineHeight: 1.4, marginBottom: 10 }}>
                {summary}
                {' '}
                Restart the
                {' '}
                <strong>TGP-CommandCenter</strong>
                {' '}
                Windows service, then hard-refresh this page.
                Process
                {' '}
                {report.appVersion || report.deploy?.process_version || '?'}
                {report.deploy?.disk_version ? ` · disk ${report.deploy.disk_version}` : ''}
                .
            </div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button
                    type="button"
                    className="st-btn"
                    style={{ width: 'auto', padding: '8px 14px', fontSize: '0.75em', borderColor: '#f90', color: '#f90' }}
                    onClick={copyCmd}
                >
                    {copied ? 'COPIED' : 'COPY RESTART COMMAND'}
                </button>
                <button
                    type="button"
                    className="st-btn subtle"
                    style={{ width: 'auto', padding: '8px 14px', fontSize: '0.75em' }}
                    onClick={refresh}
                >
                    RECHECK
                </button>
            </div>
            <div style={{ marginTop: 8, fontSize: '0.68em', opacity: 0.7, textTransform: 'none', fontFamily: 'monospace' }}>
                {cmd}
            </div>
        </div>
    );
}
