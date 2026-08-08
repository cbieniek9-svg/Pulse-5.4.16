import { Component } from 'react';

export default class ErrorBoundary extends Component {
    constructor(props) {
        super(props);
        this.state = { error: null };
    }

    static getDerivedStateFromError(error) {
        return { error };
    }

    componentDidCatch(error, info) {
        console.error('[UI CRASH]', error, info?.componentStack);
    }

    render() {
        const { error } = this.state;
        if (error) {
            return (
                <div style={{
                    minHeight: '100vh',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 24,
                    background: '#000',
                    color: '#f66',
                    textTransform: 'none',
                }}
                >
                    <div style={{
                        maxWidth: 520,
                        border: '1px solid #f44',
                        borderRadius: 8,
                        padding: 24,
                        background: 'rgba(42,10,10,0.85)',
                    }}
                    >
                        <h1 style={{ margin: '0 0 12px', color: '#f90', fontSize: '1.1em' }}>UI ERROR</h1>
                        <p style={{ margin: '0 0 16px', color: '#fcc', lineHeight: 1.5 }}>
                            The portal failed to load. Try closing and reopening TGP. If it persists, run RELEASE on the device and sign in again.
                        </p>
                        <pre style={{
                            margin: 0,
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                            fontSize: '0.8em',
                            color: '#faa',
                        }}
                        >
                            {error.message || String(error)}
                        </pre>
                    </div>
                </div>
            );
        }
        return this.props.children;
    }
}
