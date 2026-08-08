import { useState } from 'react';
import { csApiAction, upper } from './csApi.js';
import { StatusCopy } from './csShared.jsx';

function CsLegacyView({ portalCfg, user, token, onBackHub }) {
    const [customer, setCustomer] = useState('');
    const [items, setItems] = useState('');
    const [location, setLocation] = useState('1');
    const [status, setStatus] = useState({ message: '', tone: '' });
    const [btnState, setBtnState] = useState({ text: 'TRANSMIT TO FLOOR', disabled: false, style: {} });

    const handleSubmit = async (e) => {
        e.preventDefault();
        const formattedItems = upper(items).replace(/\r?\n/g, ' + ');
        const cust = upper(customer);
        if (!cust || !formattedItems) {
            setStatus({ message: 'Customer name and item list are required.', tone: 'error' });
            return;
        }
        setBtnState({ text: 'TRANSMITTING...', disabled: true, style: { background: '#fff' } });
        setStatus({ message: '', tone: '' });
        const orderId = `ORD-${Date.now()}-${Math.random().toString(36).substring(2, 7)}`.toUpperCase();
        try {
            await csApiAction({
                table: 'special_orders',
                action: 'insert',
                data: {
                    order_id: orderId,
                    customer: cust,
                    item: formattedItems,
                    contact: '',
                    location: location.toUpperCase(),
                    status: 'Open',
                    closed_by: '',
                },
            }, user, token);
            setBtnState({ text: 'ORDER LOGGED', disabled: true, style: { background: '#0f8' } });
            setStatus({ message: 'Customer order sent to the TV.', tone: 'success' });
            setTimeout(() => {
                setCustomer('');
                setItems('');
                setLocation('1');
                setBtnState({ text: 'TRANSMIT TO FLOOR', disabled: false, style: {} });
                setStatus({ message: '', tone: '' });
            }, 2000);
        } catch (err) {
            setStatus({ message: `Network error: ${err.message}`, tone: 'error' });
            setBtnState({ text: 'TRANSMIT TO FLOOR', disabled: false, style: {} });
        }
    };

    return (
        <div className="cs-box">
            <div className="cs-title">CS DIRECT DISPATCH</div>
            <form data-testid="cs-dispatch-form" onSubmit={handleSubmit}>
                <label htmlFor="cs-customer-name">Customer Name</label>
                <input
                    id="cs-customer-name"
                    data-testid="cs-customer-name"
                    className="st-input"
                    placeholder="e.g. John Doe"
                    required
                    autoComplete="off"
                    value={customer}
                    onChange={(e) => setCustomer(e.target.value)}
                />
                <label htmlFor="cs-items-list">Items Requested (List multiple)</label>
                <textarea
                    id="cs-items-list"
                    data-testid="cs-items-list"
                    className="st-input"
                    placeholder={'e.g. 2x Flats Aquafina\n1x Coke 12pk'}
                    required
                    value={items}
                    onChange={(e) => setItems(e.target.value)}
                />
                <label htmlFor="cs-order-location">Order Location</label>
                <select
                    id="cs-order-location"
                    data-testid="cs-order-location"
                    className="st-input"
                    aria-label="Order Location"
                    value={location}
                    onChange={(e) => setLocation(e.target.value)}
                >
                    <option>1</option><option>2</option><option>3</option><option>22</option>
                </select>
                <button
                    className="st-btn"
                    type="submit"
                    data-testid="cs-submit-btn"
                    disabled={btnState.disabled}
                    style={btnState.style}
                >
                    {btnState.text}
                </button>
            </form>
            <div data-testid="cs-status-message">
                <StatusCopy message={status.message} tone={status.tone} />
            </div>
            {portalCfg.hub ? (
                <p className="hint">
                    <button type="button" className="st-btn ghost sm" onClick={onBackHub}>BACK TO HUB</button>
                </p>
            ) : null}
        </div>
    );
}


export { CsLegacyView };
