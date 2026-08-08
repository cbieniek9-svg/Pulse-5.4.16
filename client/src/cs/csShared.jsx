import { printCsOrder } from './csApi.js';

function StatusCopy({ message = '', tone = '', id }) {
    return <div id={id} className={`status-copy${tone ? ` ${tone}` : ''}`}>{message}</div>;
}

function BackRow({ user, onBackHub, onBackCustomers }) {
    return (
        <div className="back-row">
            {onBackCustomers ? (
                <button type="button" className="st-btn ghost sm" onClick={onBackCustomers}>← CUSTOMERS</button>
            ) : null}
            {onBackHub ? (
                <button type="button" className="st-btn ghost sm" onClick={onBackHub}>
                    {onBackCustomers ? 'HUB' : '← HUB'}
                </button>
            ) : null}
            <span className="back-row-user">{user || 'CS'}</span>
        </div>
    );
}

function PrintBtn({ orderId, token }) {
    return (
        <button
            type="button"
            className="st-btn sm ghost"
            onClick={() => {
                printCsOrder(orderId, token).catch((err) => {
                    window.alert(err.message || 'Print failed');
                });
            }}
        >
            PRINT
        </button>
    );
}


export { StatusCopy, BackRow, PrintBtn };
