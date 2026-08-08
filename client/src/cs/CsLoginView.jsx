import { useEffect, useState } from 'react';
import { csLogin, getLoginStaff, setCsSession } from './csApi.js';
import { StatusCopy } from './csShared.jsx';

function CsLoginView({ onSuccess }) {
    const [names, setNames] = useState([]);
    const [name, setName] = useState('');
    const [pin, setPin] = useState('');
    const [status, setStatus] = useState({ message: '', tone: '' });
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        getLoginStaff()
            .then((data) => setNames(data.names || []))
            .catch((err) => setStatus({ message: err.message, tone: 'error' }));
    }, []);

    const handleLogin = async () => {
        if (!name || !pin) {
            setStatus({ message: 'Select your name and enter PIN.', tone: 'error' });
            return;
        }
        setBusy(true);
        setStatus({ message: '', tone: '' });
        try {
            const data = await csLogin(name, pin);
            setCsSession(name, data.token);
            onSuccess(name, data.token);
        } catch (err) {
            setStatus({ message: err.message, tone: 'error' });
            setBusy(false);
        }
    };

    return (
        <div className="cs-box">
            <div className="cs-title">CS UPLINK</div>
            <label htmlFor="cs-user">Your Name</label>
            <select
                id="cs-user"
                className="st-input"
                value={name}
                onChange={(e) => setName(e.target.value)}
            >
                <option value="">Select Your Name</option>
                {names.map((n) => (
                    <option key={n.name} value={n.name}>{n.name}</option>
                ))}
            </select>
            <label htmlFor="cs-pin">PIN</label>
            <input
                id="cs-pin"
                className="st-input"
                type="password"
                autoComplete="off"
                value={pin}
                onChange={(e) => setPin(e.target.value)}
            />
            <button type="button" className="st-btn" disabled={busy} onClick={handleLogin}>
                ENTER HUB
            </button>
            <StatusCopy message={status.message} tone={status.tone} />
        </div>
    );
}


export { CsLoginView };
