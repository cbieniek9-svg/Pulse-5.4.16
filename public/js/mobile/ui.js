// ── 3. UI HELPERS & ELECTRON-SAFE MODALS ───────────────────────────────────────

function showNotice(msg, tone = 'info', title = '', canUndo = false) {
    const stack = $el('notice-stack');
    if (!stack) return;
    const card = document.createElement('div');
    card.className = `notice-card ${tone}`;
    card.innerHTML = `<div class="notice-title">${esc(title || tone.toUpperCase())}</div><div class="notice-message">${esc(msg)}</div>`;
    if (canUndo) {
        const btn = document.createElement('button');
        btn.textContent = 'UNDO';
        btn.style.cssText = 'background:none;border:1px solid #8cf;color:#8cf;border-radius:12px;padding:2px 10px;font-size:0.75em;cursor:pointer;margin-top:8px;';
        btn.onclick = () => undoLastAction();
        card.appendChild(btn);
    }
    stack.appendChild(card);
    if (stack.children.length > 4) stack.removeChild(stack.firstElementChild);
    setTimeout(() => { if (card.parentNode === stack) stack.removeChild(card); }, canUndo ? 10000 : 4000);
}

// Bypasses Electron's blocked native prompt()
window.appPrompt = (msg, defaultVal = '') => {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);';
        const box = document.createElement('div');
        box.style.cssText = 'background:#1f3b5c;padding:25px;border-radius:12px;border:2px solid #0cf;color:#fff;width:350px;text-align:center;font-family:sans-serif;box-shadow:0 0 20px rgba(0,204,255,0.2);';
        
        const lbl = document.createElement('div');
        lbl.textContent = msg;
        lbl.style.marginBottom = '20px';
        lbl.style.fontSize = '1.1em';
        
        const inp = document.createElement('input');
        inp.type = 'text';
        inp.value = defaultVal;
        inp.className = 'st-input';
        inp.style.width = '100%';
        inp.style.marginBottom = '20px';
        inp.style.boxSizing = 'border-box';
        
        const btnWrap = document.createElement('div');
        btnWrap.style.display = 'flex';
        btnWrap.style.gap = '15px';
        
        const cancel = document.createElement('button');
        cancel.textContent = 'CANCEL';
        cancel.className = 'st-btn';
        cancel.style.flex = '1';
        cancel.style.borderColor = '#f44';
        cancel.style.color = '#f44';
        
        const ok = document.createElement('button');
        ok.textContent = 'OK';
        ok.className = 'st-btn';
        ok.style.flex = '1';
        ok.style.borderColor = '#0f8';
        ok.style.color = '#0f8';
        
        btnWrap.appendChild(cancel);
        btnWrap.appendChild(ok);
        box.appendChild(lbl);
        box.appendChild(inp);
        box.appendChild(btnWrap);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        
        setTimeout(() => { inp.focus(); inp.select(); }, 10);
        
        const close = (val) => { document.body.removeChild(overlay); resolve(val); };
        
        ok.onclick = () => close(inp.value);
        cancel.onclick = () => close(null);
        inp.onkeydown = (e) => { if(e.key === 'Enter') close(inp.value); if(e.key === 'Escape') close(null); };
    });
};

// Bypasses Electron's blocked native confirm()
window.appConfirm = (msg) => {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;background:rgba(0,0,0,0.85);z-index:99999;display:flex;align-items:center;justify-content:center;backdrop-filter:blur(3px);';
        const box = document.createElement('div');
        box.style.cssText = 'background:#1f3b5c;padding:25px;border-radius:12px;border:2px solid #f90;color:#fff;width:350px;text-align:center;font-family:sans-serif;box-shadow:0 0 20px rgba(255,153,0,0.2);';
        
        const lbl = document.createElement('div');
        lbl.textContent = msg;
        lbl.style.marginBottom = '20px';
        lbl.style.fontSize = '1.1em';
        
        const btnWrap = document.createElement('div');
        btnWrap.style.display = 'flex';
        btnWrap.style.gap = '15px';
        
        const cancel = document.createElement('button');
        cancel.textContent = 'CANCEL';
        cancel.className = 'st-btn';
        cancel.style.flex = '1';
        cancel.style.borderColor = '#aaa';
        cancel.style.color = '#aaa';
        
        const ok = document.createElement('button');
        ok.textContent = 'CONFIRM';
        ok.className = 'st-btn';
        ok.style.flex = '1';
        ok.style.borderColor = '#f90';
        ok.style.color = '#f90';
        
        btnWrap.appendChild(cancel);
        btnWrap.appendChild(ok);
        box.appendChild(lbl);
        box.appendChild(btnWrap);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        
        const close = (val) => { document.body.removeChild(overlay); resolve(val); };
        
        ok.onclick = () => close(true);
        cancel.onclick = () => close(false);
    });
};
