import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import ErrorBoundary from './components/shared/ErrorBoundary.jsx';
import { AuthProvider } from './lib/auth.jsx';
import { bootPulsePrefs } from './lib/pulsePrefs.js';
import { startA11yLabelObserver } from './lib/a11yAssociate.js';
import './styles/a11y.css';

bootPulsePrefs();

const rootEl = document.getElementById('root');
startA11yLabelObserver(rootEl);

createRoot(rootEl).render(
    <StrictMode>
        <ErrorBoundary>
            <AuthProvider>
                <App />
            </AuthProvider>
        </ErrorBoundary>
    </StrictMode>,
);
