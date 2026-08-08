// ── 5. AUTHENTICATION ─────────────────────────────────────────────────────────

function ensureAuthSubmitButton() {
    let submit = $el('auth-submit');
    if (!submit) {
        submit = document.querySelector('#auth-screen .st-btn');
        if (submit) {
            submit.id = 'auth-submit';
            submit.classList?.add('auth-submit');
        }
    }
    return submit;
}

function ensureManualNameEntry(select) {
    ensureAuthSubmitButton();
    let input = $el('auth-user-manual');
    let toggle = $el('auth-user-mode');
    if (!input) {
        input = document.createElement('input');
        input.id = 'auth-user-manual';
        input.className = select.className;
        input.placeholder = 'YOUR NAME';
        input.autocomplete = 'username';
        input.setAttribute?.('aria-label', 'Enter your name');
        input.style.display = 'none';
        select.after(input);
    }
    if (!toggle) {
        toggle = document.createElement('button');
        toggle.id = 'auth-user-mode';
        toggle.type = 'button';
        toggle.className = 'st-btn';
        toggle.textContent = 'Enter name manually';
        toggle.onclick = () => {
            const enteringManually = input.style.display === 'none';
            select.value = '';
            input.value = '';
            select.style.display = enteringManually ? 'none' : '';
            input.style.display = enteringManually ? '' : 'none';
            toggle.textContent = enteringManually ? 'Choose from staff list' : 'Enter name manually';
            if (enteringManually) input.focus();
        };
        input.after(toggle);
    }
    return { input, toggle };
}

async function fetchLoginStaff() {
    try {
        const r = await fetch(API_BASE + '/api/sync');
        if (!r.ok) { setTimeout(fetchLoginStaff, 5000); return; }
        const data = await r.json();
        const verEl = $el('app-version-label');
        if (verEl && data.appVersion) verEl.textContent = `VERSION ${data.appVersion}`;
        if (data?.staff) {
            const sel = $el('auth-user');
            if (!sel) return;
            ensureManualNameEntry(sel);
            const baseStaff = typeof TgpApi !== 'undefined' && TgpApi.filterLoginStaff
                ? TgpApi.filterLoginStaff(data)
                : data.staff;
            const staff = [...baseStaff].sort((a, b) => String(a.name).localeCompare(String(b.name)));
            sel.innerHTML = '<option value="" disabled selected>Select Your Name</option>';
            staff.forEach(s => {
                const o = document.createElement('option');
                o.value = o.textContent = s.name;
                sel.appendChild(o);
            });
        }
    } catch (e) {
        console.error('[LOGIN] Staff fetch failed:', e.message);
        setTimeout(fetchLoginStaff, 5000);
    }
}

async function claimDevice() {
    const manual = $el('auth-user-manual');
    const user = manual && manual.style.display !== 'none'
        ? manual.value.trim()
        : $el('auth-user')?.value;
    const pin  = $el('auth-pin')?.value;
    if (!user || !pin) { showNotice('Name and PIN required', 'error'); return; }
    const btn = $el('auth-submit');
    if (btn) { btn.disabled = true; btn.textContent = 'VERIFYING…'; }
    try {
        const res = await postJson('/api/mobile-auth', { name: user, pin });
        if (res.success) {
            sessionStorage.setItem('tgp_token', res.token);
            localStorage.removeItem('tgp_token');
            localStorage.setItem('tgp_user', res.user.name);
            location.reload();
        } else {
            showNotice(res.error || 'Authentication failed', 'error');
        }
    } catch (err) {
        showNotice(err.message, 'error');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'UNLOCK UPLINK'; }
    }
}
