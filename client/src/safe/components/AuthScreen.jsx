import { Link } from 'react-router-dom';

export default function AuthScreen({
    staff = [],
    name,
    pin,
    loading = false,
    status = '',
    onNameChange,
    onPinChange,
    onSubmit,
    backTo = '/',
    backLabel = '← Back to TGP Center Store',
}) {
    return (
        <div className="safe-auth-screen">
            <form className="auth-box" onSubmit={onSubmit}>
                <div className="title" style={{ color: '#9c0', marginBottom: 20 }}>SAFETY INSPECTIONS</div>
                <p className="hint" style={{ marginBottom: 16 }}>
                    Need <strong>Grant mobile login</strong> (Settings → Staff) plus Manager role or <strong>Safe</strong> permission.
                </p>
                <select
                    className="input"
                    value={name}
                    onChange={(e) => onNameChange(e.target.value)}
                >
                    <option value="" disabled>Select Your Name</option>
                    {staff.length ? staff.map((s) => (
                        <option key={s.name} value={s.name}>{s.name}</option>
                    )) : (
                        <option value="" disabled>No eligible staff — grant mobile login + Manager or Safe</option>
                    )}
                </select>
                <input
                    type="password"
                    className="input"
                    placeholder="PIN"
                    value={pin}
                    onChange={(e) => onPinChange(e.target.value)}
                />
                <button type="submit" className="btn btn-warn" style={{ width: '100%' }} disabled={loading}>
                    {loading ? 'VERIFYING...' : 'ENTER /SAFE'}
                </button>
                {status ? (
                    <p className="hint" style={{ color: '#f66', marginTop: 10 }}>{status}</p>
                ) : null}
                <p className="hint" style={{ marginTop: 16 }}>
                    <Link to={backTo} style={{ color: '#9c0' }}>{backLabel}</Link>
                </p>
            </form>
        </div>
    );
}
