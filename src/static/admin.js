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
// Google credentials helpers (Client ID / Secret stored in config.json)
// ---------------------------------------------------------------------------
async function loadGoogleCredentials() {
    const statusEl = document.getElementById('googleCredsStatus');
    const formEl   = document.getElementById('googleCredsForm');
    if (!statusEl) return;

    try {
        const resp = await adminFetch('/api/auth/google/credentials');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const { source, clientIdSet, clientIdHint } = await resp.json();

        if (source === 'env') {
            statusEl.textContent = `Using env vars (GOOGLE_CLIENT_ID is set${clientIdSet ? ': ' + clientIdHint : ''}).`;
            statusEl.style.color = '#8af';
            if (formEl) formEl.style.display = 'none';
        } else if (source === 'config' && clientIdSet) {
            statusEl.textContent = `Credentials saved in config (${clientIdHint}).`;
            statusEl.style.color = '#8f8';
            if (formEl) formEl.style.display = 'block';
        } else {
            statusEl.textContent = 'No credentials set. Enter your Google Cloud OAuth Client ID and Secret below.';
            statusEl.style.color = '#f88';
            if (formEl) formEl.style.display = 'block';
        }
    } catch (err) {
        statusEl.textContent = `Error: ${err.message}`;
        statusEl.style.color = '#f88';
    }
}

// ---------------------------------------------------------------------------
// Google Calendar OAuth helpers
// ---------------------------------------------------------------------------
async function loadGoogleAuthStatus() {
    const statusEl      = document.getElementById('googleAuthStatus');
    const connectBtn    = document.getElementById('googleConnectBtn');
    const disconnectBtn = document.getElementById('googleDisconnectBtn');
    const calSelectDiv  = document.getElementById('googleCalendarSelect');
    if (!statusEl) return;

    try {
        const resp   = await adminFetch('/api/auth/google/status');
        const status = await resp.json();

        if (!status.credentialsConfigured) {
            statusEl.textContent = 'GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET not set on the server.';
            statusEl.style.color = '#f88';
            return;
        }

        if (status.connected) {
            const calPart = status.calendarSummary ? ` — showing "${status.calendarSummary}"` : ' — no calendar selected yet';
            statusEl.textContent = `Connected as ${status.email}${calPart}`;
            statusEl.style.color = '#8f8';
            disconnectBtn.style.display = 'inline-block';
            connectBtn.style.display    = 'none';
            calSelectDiv.style.display  = 'block';
            await loadCalendarList(status.calendarId);
        } else {
            statusEl.textContent = 'Not connected.';
            statusEl.style.color = '#aaa';
            connectBtn.style.display    = 'inline-block';
            disconnectBtn.style.display = 'none';
            calSelectDiv.style.display  = 'none';
        }
    } catch (err) {
        statusEl.textContent = `Error checking status: ${err.message}`;
        statusEl.style.color = '#f88';
    }
}

async function loadCalendarList(selectedCalendarId) {
    const select = document.getElementById('calendarSelect');
    if (!select) return;
    select.innerHTML = '<option disabled>Loading…</option>';

    try {
        const resp = await adminFetch('/api/auth/google/calendars');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const calendars = await resp.json();

        select.innerHTML = '';
        for (const cal of calendars) {
            const opt      = document.createElement('option');
            opt.value      = cal.id;
            opt.textContent = cal.summary + (cal.primary ? ' (primary)' : '');
            if (cal.id === selectedCalendarId) opt.selected = true;
            select.appendChild(opt);
        }
        if (!selectedCalendarId && calendars.length > 0) {
            select.options[0].selected = true;
        }
    } catch (err) {
        select.innerHTML = `<option disabled>Error: ${err.message}</option>`;
    }
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

    // ---- Google Calendar OAuth ----
    const googleConnectBtn    = document.getElementById('googleConnectBtn');
    const googleDisconnectBtn = document.getElementById('googleDisconnectBtn');
    const saveCalendarBtn     = document.getElementById('saveCalendarBtn');
    const calendarSelectMsg   = document.getElementById('calendarSelectMsg');

    // ---- Device flow connect ----
    let devicePollTimer = null;

    function stopDevicePolling() {
        if (devicePollTimer) { clearInterval(devicePollTimer); devicePollTimer = null; }
        const panel = document.getElementById('deviceCodePanel');
        if (panel) panel.remove();
    }

    function showDeviceCodePanel(userCode, verificationUrl, interval) {
        stopDevicePolling();

        const panel = document.createElement('div');
        panel.id = 'deviceCodePanel';
        panel.style.cssText = 'margin-top:12px;padding:12px;background:#222;border:1px solid #555;border-radius:4px;';
        panel.innerHTML = `
            <p style="margin:0 0 8px;color:#ccc;">Visit <strong><a href="${verificationUrl}" target="_blank" style="color:#8af;">${verificationUrl}</a></strong> and enter this code:</p>
            <div style="font-size:1.8rem;letter-spacing:0.2em;font-weight:bold;margin:8px 0;">${userCode}</div>
            <p id="devicePollStatus" style="color:#aaa;margin:8px 0 4px;font-size:0.9rem;">Waiting for you to approve in your browser…</p>
            <button id="deviceCancelBtn" style="margin-top:4px;background:#333;color:#ccc;border:1px solid #555;padding:4px 10px;cursor:pointer;">Cancel</button>
        `;
        const oauthSection = document.getElementById('googleOAuthSection');
        oauthSection.appendChild(panel);

        document.getElementById('deviceCancelBtn').addEventListener('click', () => {
            stopDevicePolling();
            if (googleConnectBtn) { googleConnectBtn.disabled = false; googleConnectBtn.textContent = 'Connect Google Calendar'; }
        });

        devicePollTimer = setInterval(async () => {
            const pollStatus = document.getElementById('devicePollStatus');
            try {
                const resp = await adminFetch('/api/auth/google/device/poll');
                const data = await resp.json();

                if (data.status === 'approved') {
                    stopDevicePolling();
                    await loadGoogleAuthStatus();
                } else if (data.status === 'pending') {
                    if (data.interval) {
                        clearInterval(devicePollTimer);
                        devicePollTimer = setInterval(arguments.callee, data.interval * 1000);
                    }
                } else if (data.status === 'expired') {
                    stopDevicePolling();
                    if (pollStatus) pollStatus.textContent = 'Code expired. Click "Connect" to try again.';
                    if (pollStatus) pollStatus.style.color = '#f88';
                    if (googleConnectBtn) { googleConnectBtn.disabled = false; googleConnectBtn.textContent = 'Connect Google Calendar'; }
                } else {
                    stopDevicePolling();
                    if (pollStatus) { pollStatus.textContent = `Error: ${data.message || 'Unknown error'}`; pollStatus.style.color = '#f88'; }
                    if (googleConnectBtn) { googleConnectBtn.disabled = false; googleConnectBtn.textContent = 'Connect Google Calendar'; }
                }
            } catch (err) {
                if (pollStatus) pollStatus.textContent = `Poll error: ${err.message}`;
            }
        }, interval * 1000);
    }

    if (googleConnectBtn) {
        googleConnectBtn.addEventListener('click', async function () {
            googleConnectBtn.disabled    = true;
            googleConnectBtn.textContent = 'Starting…';
            try {
                const resp = await adminFetch('/api/auth/google/device/start', { method: 'POST' });
                if (!resp.ok) {
                    const { error } = await resp.json();
                    throw new Error(error || `HTTP ${resp.status}`);
                }
                const { userCode, verificationUrl, interval } = await resp.json();
                googleConnectBtn.textContent = 'Waiting for approval…';
                showDeviceCodePanel(userCode, verificationUrl, interval);
            } catch (err) {
                alert(`Could not start Google auth: ${err.message}`);
                googleConnectBtn.disabled    = false;
                googleConnectBtn.textContent = 'Connect Google Calendar';
            }
        });
    }

    if (googleDisconnectBtn) {
        googleDisconnectBtn.addEventListener('click', async function () {
            if (!confirm('Disconnect Google Calendar? The main page will stop showing events.')) return;
            googleDisconnectBtn.disabled = true;
            try {
                const resp = await adminFetch('/api/auth/google', { method: 'DELETE' });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                stopDevicePolling();
                await loadGoogleAuthStatus();
            } catch (err) {
                alert(`Disconnect failed: ${err.message}`);
                googleDisconnectBtn.disabled = false;
            }
        });
    }

    if (saveCalendarBtn) {
        saveCalendarBtn.addEventListener('click', async function () {
            const select = document.getElementById('calendarSelect');
            if (!select || !select.value) return;
            saveCalendarBtn.disabled = true;
            try {
                const resp = await adminFetch('/api/auth/google/calendar', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ calendarId: select.value, calendarSummary: select.options[select.selectedIndex].textContent }),
                });
                if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                showMsg(calendarSelectMsg, 'Calendar saved. Reload the main page to apply.');
                await loadGoogleAuthStatus();
            } catch (err) {
                showMsg(calendarSelectMsg, err.message, false);
            } finally {
                saveCalendarBtn.disabled = false;
            }
        });
    }

    // ---- Google credentials save ----
    const saveCredsBtn          = document.getElementById('saveCredsBtn');
    const adminClientIdInput    = document.getElementById('adminClientIdInput');
    const adminClientSecretInput = document.getElementById('adminClientSecretInput');
    const credsMessage          = document.getElementById('credsMessage');

    if (saveCredsBtn) {
        saveCredsBtn.addEventListener('click', async function () {
            const clientId     = (adminClientIdInput     ? adminClientIdInput.value.trim()     : '');
            const clientSecret = (adminClientSecretInput ? adminClientSecretInput.value.trim() : '');
            if (!clientId || !clientSecret) {
                showMsg(credsMessage, 'Enter both the Client ID and Client Secret.', false);
                return;
            }
            saveCredsBtn.disabled = true;
            try {
                const resp = await adminFetch('/api/auth/google/credentials', {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    JSON.stringify({ clientId, clientSecret }),
                });
                if (!resp.ok) throw new Error((await resp.json()).error || `HTTP ${resp.status}`);
                showMsg(credsMessage, 'Credentials saved.');
                if (adminClientSecretInput) adminClientSecretInput.value = '';
                await loadGoogleCredentials();
                await loadGoogleAuthStatus();
            } catch (err) {
                showMsg(credsMessage, err.message, false);
            } finally {
                saveCredsBtn.disabled = false;
            }
        });
    }

    loadGoogleCredentials();
    loadGoogleAuthStatus();

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
