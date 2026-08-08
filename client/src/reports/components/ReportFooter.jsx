export default function ReportFooter({ data }) {
    const store = data.store || {};
    return (
        <div style={{ textAlign: 'center', padding: 30, fontSize: '0.7rem', color: '#b0b0b0', letterSpacing: 2 }}>
            {store.displayName || 'TGP CENTER STORE'} ({store.code || ''}) — v{data.appVersion || ''} — REPORT GENERATED {new Date().toLocaleString().toUpperCase()}
        </div>
    );
}
