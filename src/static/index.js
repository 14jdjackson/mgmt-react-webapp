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
// Calendar — events list (OAuth) or iframe fallback
// Calls GET /api/calendar/events which returns one of:
//   { source: 'oauth', events: [...] }  — render events list
//   { source: 'iframe', url: '...' }    — show embed iframe
//   { source: 'none' }                  — hide section
// ---------------------------------------------------------------------------
function formatEventTime(event) {
    if (event.start.date) return 'All day';
    const t = new Date(event.start.dateTime);
    return t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
}

function dayLabel(isoDate) {
    const today    = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    if (isoDate === today)    return 'TODAY';
    if (isoDate === tomorrow) return 'TOMORROW';
    return new Date(isoDate + 'T00:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' }).toUpperCase();
}

function renderEvents(events) {
    const list = document.getElementById('eventsList');
    if (!list) return;
    list.innerHTML  = '';
    list.style.display = 'block';

    if (!events || events.length === 0) {
        const li = document.createElement('li');
        li.style.color = '#aaa';
        li.textContent = 'No upcoming events in the next 2 weeks.';
        list.appendChild(li);
        return;
    }

    const days = {};
    for (const ev of events) {
        const key = (ev.start.dateTime || ev.start.date).slice(0, 10);
        if (!days[key]) days[key] = [];
        days[key].push(ev);
    }

    for (const [day, dayEvents] of Object.entries(days)) {
        const header = document.createElement('li');
        header.style.cssText = 'font-weight:bold;color:#888;margin-top:10px;font-size:0.8rem;letter-spacing:0.05em;';
        header.textContent   = dayLabel(day);
        list.appendChild(header);

        for (const ev of dayEvents) {
            const li = document.createElement('li');
            li.style.cssText = 'display:flex;gap:10px;padding:4px 0 4px 10px;border-left:2px solid #444;margin:3px 0;';

            const time = document.createElement('span');
            time.style.cssText = 'color:#888;font-size:0.85rem;min-width:52px;flex-shrink:0;';
            time.textContent   = formatEventTime(ev);

            const title = document.createElement('span');
            title.textContent = ev.summary || '(no title)';

            li.appendChild(time);
            li.appendChild(title);
            list.appendChild(li);
        }
    }
}

async function initCalendar() {
    const calDiv = document.getElementById('calendarDiv');
    if (!calDiv) return;

    try {
        const resp = await fetch('/api/calendar/events');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();

        if (data.source === 'oauth') {
            renderEvents(data.events);
        } else if (data.source === 'iframe' && data.url) {
            const iframe = document.getElementById('calendarIframe');
            if (iframe) { iframe.src = data.url; iframe.style.display = ''; }
        } else {
            calDiv.style.display = 'none';
        }
    } catch (_) {
        calDiv.style.display = 'none';
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
