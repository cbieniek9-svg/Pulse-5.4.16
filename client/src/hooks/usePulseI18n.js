import { useCallback, useEffect, useState } from 'react';
import { getPulseState, PULSE_LANG_CHANGE } from '../lib/pulsePrefs.js';

function translate(key, lang) {
    if (typeof window !== 'undefined' && window.PulseI18n?.t) {
        return window.PulseI18n.t(key, lang);
    }
    return key;
}

export default function usePulseI18n() {
    const [lang, setLang] = useState(() => getPulseState().lang);

    useEffect(() => {
        const onChange = (event) => {
            setLang(event.detail || getPulseState().lang);
        };
        window.addEventListener(PULSE_LANG_CHANGE, onChange);
        return () => window.removeEventListener(PULSE_LANG_CHANGE, onChange);
    }, []);

    const t = useCallback((key) => translate(key, lang), [lang]);

    return { t, lang };
}
