import { useEffect, useState } from 'react';
import { getPulseState, setPulseIntensity, setPulseLang, setPulseTextScale } from '../../../lib/pulsePrefs.js';
import usePulseI18n from '../../../hooks/usePulseI18n.js';

const INTENSITY_KEYS = {
    bridge: 'bridge_mode',
    highcontrast: 'high_contrast_mode',
    dockglare: 'dock_glare_mode',
};

const SCALE_KEYS = {
    normal: 'text_normal',
    large: 'text_large',
    xl: 'text_xl',
};

export default function ProfileSettingsPanel() {
    const { t } = usePulseI18n();
    const [state, setState] = useState(() => getPulseState());

    useEffect(() => {
        setState(getPulseState());
    }, []);

    const pickIntensity = (value) => {
        setPulseIntensity(value);
        setState(getPulseState());
    };
    const pickScale = (value) => {
        setPulseTextScale(value);
        setState(getPulseState());
    };
    const pickLang = (value) => {
        setPulseLang(value);
        setState(getPulseState());
    };

    return (
        <>
            <p className="prism-display-hint">{t('prism_display_hint')}</p>
            <label className="section-label">{t('display_mode_label')}</label>
            <div className="pulse-opt-row">
                {['bridge', 'highcontrast', 'dockglare'].map((v) => (
                    <button
                        key={v}
                        type="button"
                        className={`st-btn subtle pulse-opt-btn${state.intensity === v ? ' pulse-opt-active' : ''}`}
                        onClick={() => pickIntensity(v)}
                    >
                        {t(INTENSITY_KEYS[v])}
                    </button>
                ))}
            </div>
            <label className="section-label" style={{ marginTop: 10 }}>{t('text_scale_label')}</label>
            <div className="pulse-opt-row">
                {['normal', 'large', 'xl'].map((v) => (
                    <button
                        key={v}
                        type="button"
                        className={`st-btn subtle pulse-opt-btn${state.textScale === v ? ' pulse-opt-active' : ''}`}
                        onClick={() => pickScale(v)}
                    >
                        {t(SCALE_KEYS[v])}
                    </button>
                ))}
            </div>
            <label className="section-label" style={{ marginTop: 10 }}>{t('language_label')}</label>
            <div className="pulse-opt-row">
                {['en', 'fr', 'es'].map((v) => (
                    <button
                        key={v}
                        type="button"
                        className={`st-btn subtle pulse-opt-btn${state.lang === v ? ' pulse-opt-active' : ''}`}
                        onClick={() => pickLang(v)}
                    >
                        {v.toUpperCase()}
                    </button>
                ))}
            </div>
        </>
    );
}
