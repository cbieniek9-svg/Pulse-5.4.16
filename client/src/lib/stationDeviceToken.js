const STATION_KEYS = Object.freeze({
    receiving: 'tgp.receiving.deviceToken',
    markdown: 'tgp.markdown.deviceToken',
});

function storageKey(purpose) {
    return STATION_KEYS[purpose] || '';
}

export function captureStationDeviceTokenFromUrl(purpose) {
    const key = storageKey(purpose);
    if (!key || typeof window === 'undefined' || !window.location || !window.localStorage) return '';
    const url = new URL(window.location.href);
    const hashParams = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : '');
    const deviceToken = hashParams.get('deviceToken') || '';
    if (!deviceToken) return window.localStorage.getItem(key) || '';
    window.localStorage.setItem(key, deviceToken);
    hashParams.delete('deviceToken');
    const remainingHash = hashParams.toString();
    url.hash = remainingHash ? `#${remainingHash}` : '';
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    return deviceToken;
}

export function getStationDeviceToken(purpose) {
    const key = storageKey(purpose);
    if (!key || typeof window === 'undefined' || !window.localStorage) return '';
    return window.localStorage.getItem(key) || '';
}
