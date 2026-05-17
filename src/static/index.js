// index.js — MGMT main page
//
// Chores are fetched from GET /api/chores on every load.
// Calendar URL is fetched from GET /api/calendar-url (reads data/config.json).
// Reset scheduling and checkbox state are managed client-side.

// index.js — MGMT main page
//
// Chores are fetched from GET /api/chores on every load.
// Calendar URL is fetched from GET /api/calendar-url (reads data/config.json).
// Admin PIN is verified via POST /api/pin/verify (hash stored in data/config.json).
// Reset timestamps use localStorage — see the localStorage inventory at the bottom.

// ---------------------------------------------------------------------------
// SHA-256 / PIN check
// ---------------------------------------------------------------------------
async function sha256(str) {
    const buffer = new TextEncoder().encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    return Array.from(new Uint8Array(hashBuffer))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
}

async function checkPin(code) {
    // Check whether a PIN has been configured at all first
    const existsResp = await fetch('/api/pin/exists');
    const { exists } = await existsResp.json();
    if (!exists) {
        alert('Admin PIN is not set. Set it in admin.html first.');
        return false;
    }
    const hash = await sha256(code.trim());
    const resp = await fetch('/api/pin/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hash }),
    });
    const { valid } = await resp.json();
    return valid ? hash : null;
}

// ---------------------------------------------------------------------------
// Chore loading and rendering
// ---------------------------------------------------------------------------
async function loadAndRenderChores() {
    const choresList = document.getElementById('choresList');
    if (!choresList) return;

    let allChores;
    try {
        const resp = await fetch('/api/chores');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        allChores = await resp.json();
    } catch (err) {
        choresList.innerHTML = `<li style="color:#f88">Could not load chores: ${err.message}</li>`;
        return;
    }

    choresList.innerHTML = '';
    let total = 0;

    for (const resetType of ['daily', 'weekly', 'monthly']) {
        for (const text of (allChores[resetType] || [])) {
            total++;
            const li    = document.createElement('li');
            const label = document.createElement('label');
            const input = document.createElement('input');

            input.type = 'checkbox';
            input.setAttribute('data-reset', resetType);
            input.setAttribute('data-text', text);

            // Restore checked state from sessionStorage so a page refresh
            // doesn't un-tick items the user has already marked off.
            const sessionKey = `checked_${resetType}_${text}`;
            input.checked    = sessionStorage.getItem(sessionKey) === '1';
            input.hidden     = input.checked;

            input.addEventListener('change', function () {
                this.hidden = this.checked;
                sessionStorage.setItem(sessionKey, this.checked ? '1' : '0');
            });

            label.appendChild(input);
            label.appendChild(document.createTextNode(' ' + text));
            li.appendChild(label);
            choresList.appendChild(li);
        }
    }

    if (total === 0) {
        choresList.innerHTML = '<li>No chores configured yet.</li>';
    }
}

// ---------------------------------------------------------------------------
// Reset scheduling
// ---------------------------------------------------------------------------
function shouldReset(resetType) {
    const now      = new Date();
    const lastReset = new Date(localStorage.getItem(`lastReset_${resetType}`) || 0);

    if (resetType === 'daily') {
        const dayStart = new Date(now);
        dayStart.setHours(0, 0, 0, 0);
        return lastReset < dayStart;
    }
    if (resetType === 'weekly') {
        const sunday = new Date(now);
        sunday.setDate(now.getDate() - now.getDay());
        sunday.setHours(0, 0, 0, 0);
        return lastReset < sunday;
    }
    if (resetType === 'monthly') {
        return lastReset < new Date(now.getFullYear(), now.getMonth(), 1);
    }
    return false;
}

function resetCheckboxes(resetType) {
    document.querySelectorAll(`input[type="checkbox"][data-reset="${resetType}"]`)
        .forEach(cb => {
            cb.checked = false;
            cb.hidden  = false;
            sessionStorage.removeItem(`checked_${resetType}_${cb.getAttribute('data-text')}`);
        });
    localStorage.setItem(`lastReset_${resetType}`, new Date().toISOString());
}

function applyDueResets() {
    ['daily', 'weekly', 'monthly'].forEach(type => {
        if (shouldReset(type)) resetCheckboxes(type);
    });
}

function scheduleDailyReset() {
    const now          = new Date();
    const nextMidnight = new Date(now);
    nextMidnight.setDate(now.getDate() + 1);
    nextMidnight.setHours(0, 0, 0, 0);
    setTimeout(function () {
        applyDueResets();
        scheduleDailyReset();
    }, nextMidnight - now);
}

// ---------------------------------------------------------------------------
// Calendar iframe
// URL comes exclusively from GET /api/calendar-url which reads data/config.json.
// No localStorage fallback — the config file is the single source of truth.
// ---------------------------------------------------------------------------
async function initCalendar() {
    const iframe = document.querySelector('#calendarDiv iframe');
    if (!iframe) return;

    try {
        const resp = await fetch('/api/calendar-url');
        if (!resp.ok) return;
        const { url } = await resp.json();
        if (url) {
            iframe.src = url;
        } else {
            const calDiv = document.getElementById('calendarDiv');
            if (calDiv) calDiv.style.display = 'none';
        }
    } catch (_) {
        const calDiv = document.getElementById('calendarDiv');
        if (calDiv) calDiv.style.display = 'none';
    }
}

// ---------------------------------------------------------------------------
// Date/time label
// ---------------------------------------------------------------------------
function updateDateTime() {
    const label = document.getElementById('dateTimeLabel');
    if (!label) return;
    label.textContent = `Date/Time: ${new Date().toLocaleString([], {
        year: 'numeric', month: 'short', day: 'numeric',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false,
    })}`;
}

// ---------------------------------------------------------------------------
// Admin PIN gate
// ---------------------------------------------------------------------------
async function askAdminPin() {
    const code = prompt('Enter 4-digit admin PIN to continue:');
    if (code === null) return;
    if (!/^\d{4}$/.test(code.trim())) {
        alert('Please enter a valid 4-digit PIN.');
        return;
    }
    const hash = await checkPin(code);
    if (hash) {
        sessionStorage.setItem('adminPinHash', hash);
        window.location.href = 'admin.html';
    } else {
        alert('Wrong PIN. Access denied.');
    }
}

// ---------------------------------------------------------------------------
// Init
// ---------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', async function () {
    // Redirect to setup if no PIN has been configured yet
    try {
        const existsResp = await fetch('/api/pin/exists');
        const { exists } = await existsResp.json();
        if (!exists) {
            window.location.href = 'setup.html';
            return;
        }
    } catch (_) { /* server unreachable — fall through and show page as-is */ }

    const loginButton = document.getElementById('loginButton');
    if (loginButton) loginButton.addEventListener('click', askAdminPin);

    await loadAndRenderChores();
    applyDueResets();
    await initCalendar();

    updateDateTime();
    setInterval(updateDateTime, 1000);
    scheduleDailyReset();
});
