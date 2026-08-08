// ── 10. LIFECYCLE ─────────────────────────────────────────────────────────────

async function fetchWeather() {
    try {
        const r = await fetch('https://api.open-meteo.com/v1/forecast?latitude=53.5461&longitude=-113.4938&current=temperature_2m,weather_code');
        if (!r.ok) return;
        const d = await r.json();
        const code = d?.current?.weather_code;
        const temp = d?.current?.temperature_2m;
        if (code == null || temp == null) return;
        let icon = '☁️';
        if (code<=1) icon='☀️'; else if(code<=3) icon='⛅'; else if(code<=69) icon='🌧️'; else if(code<=79) icon='❄️';
        weatherStr = `${icon} ${Math.round(temp)}°C`;
        const el = $el('weather-display');
        if (el) el.textContent = weatherStr;
    } catch(_) { /* non-fatal */ }
}

/** file:// mobile builds resolve href="/reports" incorrectly — jump to the real server. */
function wireReportsDashboardLink() {
    const rep = $el('reports-dashboard-link');
    if (!rep || rep.dataset.wired === '1') return;
    if (window.location.protocol !== 'file:') return;
    rep.dataset.wired = '1';
    rep.addEventListener('click', (e) => {
        e.preventDefault();
        window.location.href = 'http://127.0.0.1:3001/reports';
    });
}

function init() {
    wireReportsDashboardLink();
    document.addEventListener('visibilitychange', () => {
        if (document.hidden || !isAuthed) return;
        void sync(true);
        connectStream();
    });
    if (isAuthed) {
        const authScr = $el('auth-screen');
        const appScr  = $el('app-screen');
        if (authScr) authScr.style.display = 'none';
        if (appScr)  appScr.style.display  = 'flex';
        const userEl = $el('display-user');
        if (userEl) userEl.innerText = currentUser;
        setInterval(() => { const el=$el('live-time'); if(el) el.innerText=new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}); }, 1000);
        sync(true);
        connectStream();
        startShiftPphTicker();
        startSessionKeepalive();
        // online-only fires on an offline→online edge; a cold reload while connected
        // never gets that edge, so drain any leftover queue now.
        if (typeof replayOfflineQueue === 'function' && navigator.onLine) {
            void replayOfflineQueue();
        }
    } else {
        const authScr = $el('auth-screen');
        const appScr  = $el('app-screen');
        if (authScr) authScr.style.display = 'flex';
        if (appScr)  appScr.style.display  = 'none';
        fetchLoginStaff();
    }
}

init();
fetchWeather();
setInterval(fetchWeather, 10 * 60 * 1000); // refresh weather every 10 min
setInterval(() => sync(), 90000);           // background sync every 90s (lighter on SQLite + LAN)
