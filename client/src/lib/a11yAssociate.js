'use strict';

/**
 * Wire visible field labels to their controls for axe/Lighthouse.
 * Safe to run repeatedly; skips controls that already have an accessible name.
 */
export function associateLabeledControls(root = document) {
    if (!root || typeof root.querySelectorAll !== 'function') return;

    root.querySelectorAll('.form-group, .mgr-form-grid > div, .field, .count-field').forEach((group) => {
        const lab = group.querySelector('label.label, label.mgr-field-label, label.field-label, .label, .mgr-field-label, .field-label');
        const control = group.querySelector('select, input:not([type="hidden"]):not([type="checkbox"]):not([type="radio"]), textarea');
        if (!lab || !control) return;
        const text = String(lab.textContent || '').replace(/\s+/g, ' ').trim();
        if (!text) return;
        if (control.getAttribute('aria-label') || control.getAttribute('aria-labelledby')) return;
        if (control.labels && control.labels.length) return;

        if (lab.tagName === 'LABEL') {
            if (!control.id) {
                control.id = `tgp-field-${Math.random().toString(36).slice(2, 10)}`;
            }
            if (!lab.htmlFor) lab.htmlFor = control.id;
            return;
        }

        control.setAttribute('aria-label', text);
    });

    root.querySelectorAll('select.task-assignee-select:not([aria-label])').forEach((el) => {
        el.setAttribute('aria-label', 'Assign task');
    });

    root.querySelectorAll('input[type="date"]:not([aria-label]):not([id])').forEach((el) => {
        if (el.labels && el.labels.length) return;
        el.setAttribute('aria-label', 'Date');
    });
}

/** Debounced MutationObserver so SPA updates keep controls named. */
export function startA11yLabelObserver(rootEl) {
    if (!rootEl || typeof MutationObserver === 'undefined') {
        associateLabeledControls(rootEl || document);
        return () => {};
    }
    let timer = null;
    const run = () => associateLabeledControls(rootEl);
    run();
    const mo = new MutationObserver(() => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(run, 80);
    });
    mo.observe(rootEl, { childList: true, subtree: true });
    return () => {
        mo.disconnect();
        if (timer) clearTimeout(timer);
    };
}
