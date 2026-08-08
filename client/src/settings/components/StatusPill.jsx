export default function StatusPill({ status }) {
    const s = String(status || 'warning').toLowerCase();
    const safe = s === 'ok' || s === 'error' || s === 'warning' ? s : 'warning';
    return <span className={`mgr-pill ${safe}`}>{safe}</span>;
}
