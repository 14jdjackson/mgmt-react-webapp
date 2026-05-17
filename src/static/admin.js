// admin.js — MGMT admin page logic
//
// Chores are stored in server-side .txt files (data/chores/daily.txt etc.)
// The admin PIN hash is stored in data/config.json via POST /api/pin.
// The verified PIN hash is kept in sessionStorage for the duration of the session
// and removed automatically when the user leaves the page (pagehide).

// ---------------------------------------------------------------------------
// SHA-256 helper — no plain-text PIN is ever stored or transmitted
// ---------------------------------------------------------------------------
async function sha256(str) {
    const buffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

// ---------------------------------------------------------------------------
// Authenticated fetch — attaches the session PIN hash to every request.
// Uses _fetch (a stable alias to window.fetch) so that replacing all fetch(
// calls in this file with adminFetch( does not create infinite recursion here.
// Redirects to index.html on 401/403 (invalid or expired session).
// ---------------------------------------------------------------------------
const _fetch = window.fetch.bind(window);
async function adminFetch(url, options = {}) {
    const hash = sessionStorage.getItem('adminPinHash') || '';
    const headers = { ...options.headers };
    if (hash) headers['X-Admin-Pin-Hash'] = hash;
    const resp = await _fetch(url, { ...options, headers });
    if (resp.status === 401 || resp.status === 403) {
        sessionStorage.removeItem('adminPinHash');
        window.location.replace('index.html');
    }
    return resp;
}

async function setAdminPin(pin) {
    if (!/^\d{4}$/.test(pin)) throw new Error('PIN must be exactly 4 digits.');
    const hash = await sha256(pin);
    const resp = await adminFetch('/api/pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to save PIN.');
    return hash;
}

// ---------------------------------------------------------------------------
// Server API helpers
// ---------------------------------------------------------------------------

async function fetchAllChores() {
    const resp = await adminFetch('/api/chores');
    if (!resp.ok) throw new Error(`Failed to load chores (${resp.status})`);
    return resp.json();
}

async function addChoreToServer(text, resetType) {
    if (!text || !text.trim()) throw new Error('Chore text is required.');
    const resp = await adminFetch(`/api/chores/${resetType}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: text.trim() }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to add chore.');
    return data;
}

async function removeChoreFromServer(text, resetType) {
    const resp = await adminFetch(`/api/chores/${resetType}/by-text`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Failed to remove chore.');
    return data;
}

// ---------------------------------------------------------------------------
// Render admin chore list
// ---------------------------------------------------------------------------
async function renderChoreList() {
    const list  = document.getElementById('adminChoreList');
    const empty = document.getElementById('adminChoreListEmpty');
    if (!list || !empty) return;

    list.innerHTML = '';
    empty.style.display = 'none';

    let allChores;
    try {
        allChores = await fetchAllChores();
    } catch (err) {
        empty.textContent = `Error loading chores: ${err.message}`;
        empty.style.display = 'block';
        return;
    }

    const entries = [];
    for (const resetType of ['daily', 'weekly', 'monthly']) {
        for (const text of (allChores[resetType] || [])) {
            entries.push({ text, resetType });
        }
    }

    if (entries.length === 0) {
        empty.style.display = 'block';
        return;
    }

    entries.forEach(({ text, resetType }) => {
        const li  = document.createElement('li');
        li.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 0;';

        const label = document.createElement('span');
        label.textContent = `${text} (${resetType})`;

        const btn = document.createElement('button');
        btn.textContent = 'Remove';
        btn.style.marginLeft = '10px';
        btn.addEventListener('click', async () => {
            btn.disabled    = true;
            btn.textContent = 'Removing…';
            try {
                await removeChoreFromServer(text, resetType);
                await renderChoreList();
            } catch (err) {
                alert(`Could not remove chore: ${err.message}`);
                btn.disabled    = false;
                btn.textContent = 'Remove';
            }
        });

        li.appendChild(label);
        li.appendChild(btn);
        list.appendChild(li);
    });
}

// ---------------------------------------------------------------------------
// Calendar URL
// Saving POSTs to /api/calendar-url which writes data/config.json on disk —
// the value persists across container restarts as long as /app/data is a
// mounted volume. This is the functional equivalent of updating an env var.
// ---------------------------------------------------------------------------
async function loadCalendarUrl() {
    const input = document.getElementById('calendarUrlInput');
    if (!input) return;
    try {
        const resp = await adminFetch('/api/calendar-url');
        if (!resp.ok) return;
        const { url } = await resp.json();
        if (url) input.value = url;
    } catch (_) { /* non-fatal */ }
}

async function saveCalendarUrl(url) {
    if (!url || !url.startsWith('https://calendar.google.com/')) {
        throw new Error('Must be a valid Google Calendar embed URL (https://calendar.google.com/…)');
    }
    const resp = await adminFetch('/api/calendar-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url }),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || 'Server rejected the URL.');
    return data;
}

// ---------------------------------------------------------------------------
// UI helpers
// ---------------------------------------------------------------------------
function showMsg(el, msg, ok = true) {
    if (!el) return;
    el.textContent      = msg;
    el.style.color      = ok ? 'green' : 'red';
    el.style.display    = 'block';
}

// ---------------------------------------------------------------------------
// DOMContentLoaded — wire all UI
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', function () {

    if (!sessionStorage.getItem('adminPinHash')) {
        window.location.replace('index.html');
        return;
    }

    // ---- Add single chore ----
    const addChoreBtn      = document.getElementById('addChoreBtn');
    const newChoreInput    = document.getElementById('newChore');
    const choreResetSelect = document.getElementById('choreReset');
    const choreMessage     = document.getElementById('choreMessage');

    addChoreBtn.addEventListener('click', async function () {
        const text      = newChoreInput.value.trim();
        const resetType = choreResetSelect.value;

        if (resetType === 'none') {
            showMsg(choreMessage, 'Please select a reset type (daily, weekly, or monthly).', false);
            return;
        }

        addChoreBtn.disabled = true;
        try {
            await addChoreToServer(text, resetType);
            showMsg(choreMessage, 'Chore added successfully.');
            newChoreInput.value    = '';
            choreResetSelect.value = 'none';
            await renderChoreList();
        } catch (err) {
            showMsg(choreMessage, err.message, false);
        } finally {
            addChoreBtn.disabled = false;
        }
    });

    // ---- Admin PIN ----
    const setAdminPinBtn  = document.getElementById('setAdminPinBtn');
    const adminPinInput   = document.getElementById('adminPinInput');
    const adminPinMessage = document.getElementById('adminPinMessage');

    setAdminPinBtn.addEventListener('click', async function () {
        try {
            const newHash = await setAdminPin(adminPinInput.value.trim());
            sessionStorage.setItem('adminPinHash', newHash);
            showMsg(adminPinMessage, 'Admin PIN set successfully.');
            adminPinInput.value = '';
        } catch (err) {
            showMsg(adminPinMessage, err.message, false);
        }
    });

    // ---- Bulk import ----
    const choreFileInput  = document.getElementById('choreFileInput');
    const importResetType = document.getElementById('importResetType');
    const importChoreBtn  = document.getElementById('importChoreBtn');
    const importMessage   = document.getElementById('importMessage');

    importChoreBtn.addEventListener('click', function () {
        if (!choreFileInput.files || choreFileInput.files.length === 0) {
            showMsg(importMessage, 'Please select a .txt file first.', false);
            return;
        }
        const file      = choreFileInput.files[0];
        const resetType = importResetType.value || 'daily';

        const reader = new FileReader();
        reader.onload = async function (e) {
            const lines = e.target.result
                .split(/\r?\n/)
                .map(l => l.trim())
                .filter(l => l.length > 0);

            if (lines.length === 0) {
                showMsg(importMessage, 'No chores found in file.', false);
                return;
            }

            importChoreBtn.disabled = true;
            let added = 0;
            for (const line of lines) {
                try { await addChoreToServer(line, resetType); added++; }
                catch (_) { /* skip duplicates or blanks */ }
            }
            await renderChoreList();
            showMsg(importMessage, `${added} chore(s) imported as ${resetType} tasks.`);
            choreFileInput.value   = '';
            importResetType.value  = 'daily';
            importChoreBtn.disabled = false;
        };
        reader.onerror = () => showMsg(importMessage, 'Error reading file.', false);
        reader.readAsText(file);
    });

    // ---- Calendar URL ----
    const saveCalendarUrlBtn = document.getElementById('saveCalendarUrlBtn');
    const calendarUrlInput   = document.getElementById('calendarUrlInput');
    const calendarUrlMessage = document.getElementById('calendarUrlMessage');

    if (saveCalendarUrlBtn && calendarUrlInput) {
        saveCalendarUrlBtn.addEventListener('click', async function () {
            try {
                await saveCalendarUrl(calendarUrlInput.value.trim());
                showMsg(calendarUrlMessage, 'Calendar URL saved to server. Reload the main page to apply.');
            } catch (err) {
                showMsg(calendarUrlMessage, err.message, false);
            }
        });
        loadCalendarUrl();
    }

    // ---- Reset everything ----
    const resetBtn     = document.getElementById('resetBtn');
    const resetMessage = document.getElementById('resetMessage');

    if (resetBtn) {
        resetBtn.addEventListener('click', async function () {
            if (!confirm('This will erase the PIN, calendar URL, and ALL chores. Are you sure?')) return;
            if (!confirm('Last chance — this cannot be undone. Reset everything?')) return;

            resetBtn.disabled = true;
            try {
                const resp = await adminFetch('/api/reset', { method: 'POST' });
                if (!resp.ok) throw new Error('Server error during reset.');
                showMsg(resetMessage, 'Reset complete. Redirecting to setup…');
                setTimeout(() => { window.location.href = 'setup.html'; }, 1500);
            } catch (err) {
                showMsg(resetMessage, err.message, false);
                resetBtn.disabled = false;
            }
        });
    }

    // ---- Logout ----
    const logoutButton = document.getElementById('logoutButton');
    if (logoutButton) {
        logoutButton.addEventListener('click', function () {
            sessionStorage.removeItem('adminPinHash');
            window.location.replace('index.html');
        });
    }

    // ---- Initial render ----
    renderChoreList();
});

// Clear the session hash whenever the page is hidden or unloaded (back button,
// tab close, navigate away). pagehide is more reliable than beforeunload and
// also fires when the browser puts the page in the back-forward cache.
window.addEventListener('pagehide', function () {
    sessionStorage.removeItem('adminPinHash');
});

// When the browser restores admin.html from the bfcache (user pressed back
// then forward), DOMContentLoaded does not re-fire — check auth here instead.
window.addEventListener('pageshow', function (e) {
    if (e.persisted && !sessionStorage.getItem('adminPinHash')) {
        window.location.replace('index.html');
    }
});
